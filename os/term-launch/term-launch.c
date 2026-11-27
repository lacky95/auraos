/*
 * aura-term-launch: the session launcher of a System Terminal instance
 * (Phase 5 stream T2, owner decision 2026-11-27).
 *
 * A Terminal instance is one user's session host (D69). Its server holds the
 * instance's lifecycle token, the shell's relay key and the session hook key,
 * so it runs under its own non-login service uid (`aura-terminal`, identity
 * types.ts TERMINAL_SERVICE_UID), never as the user: the user's sessions can't
 * read its /proc (environ, fd, maps, mem), attach a debugger or signal it.
 * The sessions (tmux, the shells) still run as the user's uid and gid with the
 * Private Home. This program is the one place that crosses between the two:
 *
 *   aura-term-launch serve --service UID:GID --user UID:GID -- CMD [ARG...]
 *       PID 1's child in the container (`--user 0:0 --cap-drop ALL
 *       --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges`):
 *       binds the abstract socket @aura-term-launch, then starts CMD (the
 *       start script and the server) as the service uid, and serves `run`
 *       requests until the server exits; its status is the container's.
 *       Nothing else runs as root, and it never runs anything as root.
 *   aura-term-launch run [--] PROG [ARG...]
 *       The client, run by the server: hands its stdin/stdout/stderr (a pipe
 *       or the PTY node-pty made) and its argv, environment and cwd to the
 *       launcher, which runs PROG as the session user on exactly those
 *       descriptors; forwards SIGHUP/INT/QUIT/TERM/USR1/USR2 to it and exits
 *       with its status (125: the launcher could not run it).
 *   aura-term-tmux ARG...   (a link to this binary)
 *       `run tmux ARG...`: the server's tmux binary (AURA_TERM_TMUX_BIN).
 *
 * Authorization: a request is served only when SO_PEERCRED says its peer runs
 * as the service uid; the target is fixed by the kernel's `serve` arguments
 * (the session uid/gid, never 0, never the service uid). Each request runs in
 * its own child: it drops to the session uid/gid (no supplementary group) and
 * relays signals and the exit status; the command itself starts in a new
 * session with the PTY (if any) as its controlling terminal, so a resize's
 * SIGWINCH reaches it. A uid change from 0 clears every capability; the
 * container's no-new-privileges keeps any exec from gaining one back. The
 * session environment gets the account's USER/LOGNAME/HOME from /etc/passwd
 * and never the lifecycle token variables.
 *
 * What it is not: a security boundary inside the user's own uid (sessions
 * share it by design), and not a debugger shield for the service uid by any
 * binary property: the boundary is the uid itself.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

extern char **environ;

#define SOCK_NAME   "aura-term-launch"
#define MAGIC       0x41544c31u          /* "ATL1" */
#define MAX_PAYLOAD (8u << 20)           /* argv + env + cwd */
#define MAX_STRINGS 65536
#define F_TTY       1u

struct req_head {
  uint32_t magic;
  uint32_t flags;
  uint32_t payload;
};

static void die(int code, const char *fmt, const char *arg) {
  fprintf(stderr, "aura-term-launch: ");
  fprintf(stderr, fmt, arg ? arg : "");
  fputc('\n', stderr);
  _exit(code);
}

static int parse_ids(const char *s, uid_t *uid, gid_t *gid) {
  char *end;
  errno = 0;
  unsigned long u = strtoul(s, &end, 10);
  if (errno || end == s || *end != ':') return -1;
  const char *g = end + 1;
  unsigned long v = strtoul(g, &end, 10);
  if (errno || end == g || *end) return -1;
  if (u == 0 || v == 0 || u > 0x7fffffffUL || v > 0x7fffffffUL) return -1;
  *uid = (uid_t)u; *gid = (gid_t)v;
  return 0;
}

static socklen_t sock_addr(struct sockaddr_un *a) {
  memset(a, 0, sizeof *a);
  a->sun_family = AF_UNIX;
  memcpy(a->sun_path + 1, SOCK_NAME, sizeof SOCK_NAME - 1);   /* abstract: leading NUL */
  return (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + sizeof SOCK_NAME - 1);
}

/* Drops to uid/gid for good: no supplementary group, real = effective = saved. */
static void drop_to(uid_t uid, gid_t gid) {
  if (setgroups(0, NULL) != 0) die(125, "setgroups: %s", strerror(errno));
  if (setresgid(gid, gid, gid) != 0) die(125, "setresgid: %s", strerror(errno));
  if (setresuid(uid, uid, uid) != 0) die(125, "setresuid: %s", strerror(errno));
  uid_t r, e, s; gid_t gr, ge, gs;
  if (getresuid(&r, &e, &s) || getresgid(&gr, &ge, &gs) || r != uid || e != uid || s != uid || gr != gid || ge != gid || gs != gid) {
    die(125, "%sidentity did not change", NULL);
  }
  /* Back to 0 must fail now (the capabilities went with the uid change). */
  if (setuid(0) == 0) die(125, "%sstill privileged after the drop", NULL);
}

static ssize_t read_full(int fd, void *buf, size_t n) {
  size_t got = 0;
  while (got < n) {
    ssize_t r = read(fd, (char *)buf + got, n - got);
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) return r < 0 ? -1 : (ssize_t)got;
    got += (size_t)r;
  }
  return (ssize_t)got;
}

static int write_full(int fd, const void *buf, size_t n) {
  size_t put = 0;
  while (put < n) {
    ssize_t w = write(fd, (const char *)buf + put, n - put);
    if (w < 0 && errno == EINTR) continue;
    if (w <= 0) return -1;
    put += (size_t)w;
  }
  return 0;
}

/* ── serve: one request (a child of the launcher, root until the drop) ───── */

/* The session account from the container's /etc/passwd (root-owned, read-only). */
static void account_of(uid_t uid, char *name, size_t nlen, char *home, size_t hlen) {
  snprintf(name, nlen, "user-%u", (unsigned)uid);
  snprintf(home, hlen, "/");
  FILE *f = fopen("/etc/passwd", "re");
  if (!f) return;
  char line[1024];
  while (fgets(line, sizeof line, f)) {
    char *fields[7]; int n = 0; char *p = line;
    line[strcspn(line, "\n")] = 0;
    while (n < 7) { fields[n++] = p; p = strchr(p, ':'); if (!p) break; *p++ = 0; }
    if (n < 6) continue;
    char *end; unsigned long u = strtoul(fields[2], &end, 10);
    if (*end || u != uid) continue;
    snprintf(name, nlen, "%s", fields[0]);
    snprintf(home, hlen, "%s", fields[5][0] ? fields[5] : "/");
    break;
  }
  fclose(f);
}

static int env_dropped(const char *kv) {
  static const char *const drop[] = {
    "AURA_LIFECYCLE_TOKEN=", "AURA_LIFECYCLE_TOKEN_FILE=", "USER=", "LOGNAME=", "HOME=", NULL,
  };
  for (int i = 0; drop[i]; i++) if (strncmp(kv, drop[i], strlen(drop[i])) == 0) return 1;
  return 0;
}

static void serve_request(int conn, uid_t uid, gid_t gid) {
  /* The header and the three descriptors, then the payload. */
  struct req_head h;
  int fds[3] = { -1, -1, -1 };
  char cbuf[CMSG_SPACE(sizeof fds)];
  struct iovec iov = { &h, sizeof h };
  struct msghdr m = { .msg_iov = &iov, .msg_iovlen = 1, .msg_control = cbuf, .msg_controllen = sizeof cbuf };
  ssize_t r;
  do r = recvmsg(conn, &m, MSG_CMSG_CLOEXEC); while (r < 0 && errno == EINTR);
  if (r != (ssize_t)sizeof h || h.magic != MAGIC || h.payload == 0 || h.payload > MAX_PAYLOAD) _exit(125);
  struct cmsghdr *c = CMSG_FIRSTHDR(&m);
  if (!c || c->cmsg_level != SOL_SOCKET || c->cmsg_type != SCM_RIGHTS || c->cmsg_len != CMSG_LEN(sizeof fds) || (m.msg_flags & MSG_CTRUNC)) _exit(125);
  memcpy(fds, CMSG_DATA(c), sizeof fds);

  char *buf = malloc(h.payload + 1);
  if (!buf || read_full(conn, buf, h.payload) != (ssize_t)h.payload) _exit(125);
  buf[h.payload] = 0;
  if (buf[h.payload - 1] != 0) _exit(125);
  /* cwd \0 argc \0 argv... \0 env... \0 */
  char *strs[MAX_STRINGS]; size_t ns = 0;
  for (char *p = buf; p < buf + h.payload && ns < MAX_STRINGS; p += strlen(p) + 1) strs[ns++] = p;
  if (ns < 3) _exit(125);
  char *end; unsigned long argc = strtoul(strs[1], &end, 10);
  if (*end || argc == 0 || argc > ns - 2 || !strs[2][0]) _exit(125);
  char **argv = calloc(argc + 1, sizeof *argv);
  size_t nenv = ns - 2 - argc;
  char **envp = calloc(nenv + 4, sizeof *envp);
  if (!argv || !envp) _exit(125);
  for (size_t i = 0; i < argc; i++) argv[i] = strs[2 + i];
  size_t e = 0;
  for (size_t i = 2 + argc; i < ns; i++) if (!env_dropped(strs[i])) envp[e++] = strs[i];
  char name[256], home[PATH_MAX], kv[3][PATH_MAX + 16];
  account_of(uid, name, sizeof name, home, sizeof home);
  snprintf(kv[0], sizeof kv[0], "USER=%s", name);
  snprintf(kv[1], sizeof kv[1], "LOGNAME=%s", name);
  snprintf(kv[2], sizeof kv[2], "HOME=%s", home);
  envp[e++] = kv[0]; envp[e++] = kv[1]; envp[e++] = kv[2]; envp[e] = NULL;

  sigset_t chld, none;
  sigemptyset(&chld); sigaddset(&chld, SIGCHLD); sigemptyset(&none);
  sigprocmask(SIG_BLOCK, &chld, NULL);
  pid_t pid = fork();
  if (pid < 0) _exit(125);
  if (pid == 0) {
    sigprocmask(SIG_SETMASK, &none, NULL);
    if (setsid() < 0) die(125, "setsid: %s", strerror(errno));
    for (int i = 0; i < 3; i++) if (dup2(fds[i], i) < 0) die(125, "dup2: %s", strerror(errno));
    close_range(3, ~0U, 0);
    /* The PTY becomes this session's controlling terminal (the client gave it up), so a resize's SIGWINCH reaches the command. */
    if ((h.flags & F_TTY) && isatty(0) && ioctl(0, TIOCSCTTY, 0) != 0) {
      fprintf(stderr, "aura-term-launch: no controlling terminal: %s\n", strerror(errno));
    }
    drop_to(uid, gid);
    prctl(PR_SET_PDEATHSIG, SIGKILL);
    if (chdir(strs[0]) != 0 && chdir(home) != 0 && chdir("/") != 0) die(125, "chdir: %s", strerror(errno));
    environ = envp;                     /* execvp searches the session's PATH */
    execvp(argv[0], argv);
    fprintf(stderr, "aura-term-launch: %s: %s\n", argv[0], strerror(errno));
    _exit(errno == ENOENT ? 127 : 126);
  }
  for (int i = 0; i < 3; i++) close(fds[i]);
  /* This relay holds nothing of the server's: it runs as the user too, only to signal and wait. */
  drop_to(uid, gid);
  int sfd = signalfd(-1, &chld, SFD_CLOEXEC);
  if (sfd < 0) { kill(pid, SIGKILL); _exit(125); }
  int conn_open = 1;
  for (;;) {
    int st;
    pid_t w = waitpid(pid, &st, WNOHANG);
    if (w == pid) {
      int32_t out = st;
      if (conn_open) (void)write_full(conn, &out, sizeof out);
      _exit(0);
    }
    struct pollfd p[2] = { { sfd, POLLIN, 0 }, { conn_open ? conn : -1, POLLIN, 0 } };
    if (poll(p, 2, -1) < 0 && errno != EINTR) { kill(pid, SIGKILL); _exit(125); }
    if (p[0].revents & POLLIN) { struct signalfd_siginfo si; (void)read(sfd, &si, sizeof si); }
    if (conn_open && (p[1].revents & (POLLIN | POLLHUP | POLLERR))) {
      unsigned char sig;
      ssize_t n = read(conn, &sig, 1);
      if (n == 1) {
        if (sig == SIGHUP || sig == SIGINT || sig == SIGQUIT || sig == SIGTERM || sig == SIGUSR1 || sig == SIGUSR2) kill(pid, sig);
      } else if (n == 0 || (n < 0 && errno != EINTR && errno != EAGAIN)) {
        /* The client is gone (killed): so is its command. */
        conn_open = 0;
        kill(pid, SIGKILL);
      }
    }
  }
}

static int serve(int argc, char **argv) {
  uid_t su = 0, uu = 0; gid_t sg = 0, ug = 0;
  int i = 2;
  for (; i < argc; i++) {
    if (!strcmp(argv[i], "--")) { i++; break; }
    if (!strcmp(argv[i], "--service") && i + 1 < argc) { if (parse_ids(argv[++i], &su, &sg)) die(125, "bad --service %s", argv[i]); }
    else if (!strcmp(argv[i], "--user") && i + 1 < argc) { if (parse_ids(argv[++i], &uu, &ug)) die(125, "bad --user %s", argv[i]); }
    else die(125, "unknown argument %s", argv[i]);
  }
  if (i >= argc) die(125, "%sserve: no command", NULL);
  if (!su || !uu) die(125, "%sserve: --service and --user are required", NULL);
  if (su == uu || sg == ug) die(125, "%sserve: the service and the session user must differ", NULL);
  if (geteuid() != 0) die(125, "%sserve: must start as root (it only ever drops)", NULL);

  int ls = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  struct sockaddr_un a; socklen_t al = sock_addr(&a);
  if (ls < 0 || bind(ls, (struct sockaddr *)&a, al) != 0 || listen(ls, 64) != 0) die(125, "socket: %s", strerror(errno));

  sigset_t set, old;
  sigemptyset(&set);
  sigaddset(&set, SIGCHLD); sigaddset(&set, SIGTERM); sigaddset(&set, SIGINT);
  sigaddset(&set, SIGHUP); sigaddset(&set, SIGQUIT); sigaddset(&set, SIGUSR1); sigaddset(&set, SIGUSR2);
  sigprocmask(SIG_BLOCK, &set, &old);
  int sfd = signalfd(-1, &set, SFD_CLOEXEC);
  if (sfd < 0) die(125, "signalfd: %s", strerror(errno));

  pid_t server = fork();
  if (server < 0) die(125, "fork: %s", strerror(errno));
  if (server == 0) {
    sigprocmask(SIG_SETMASK, &old, NULL);
    drop_to(su, sg);
    prctl(PR_SET_PDEATHSIG, SIGTERM);
    execvp(argv[i], argv + i);
    fprintf(stderr, "aura-term-launch: %s: %s\n", argv[i], strerror(errno));
    _exit(127);
  }
  fprintf(stderr, "aura-term-launch: server pid %d as uid %u; sessions as uid %u\n", (int)server, (unsigned)su, (unsigned)uu);
  int refused = 0;
  for (;;) {
    struct pollfd p[2] = { { sfd, POLLIN, 0 }, { ls, POLLIN, 0 } };
    if (poll(p, 2, -1) < 0) { if (errno == EINTR) continue; die(125, "poll: %s", strerror(errno)); }
    if (p[0].revents & POLLIN) {
      struct signalfd_siginfo si;
      if (read(sfd, &si, sizeof si) == (ssize_t)sizeof si && si.ssi_signo != SIGCHLD) kill(server, (int)si.ssi_signo);
      int st; pid_t w;
      while ((w = waitpid(-1, &st, WNOHANG)) > 0) {
        if (w != server) continue;
        if (WIFEXITED(st)) _exit(WEXITSTATUS(st));
        _exit(128 + WTERMSIG(st));
      }
    }
    if (p[1].revents & POLLIN) {
      int conn = accept4(ls, NULL, NULL, SOCK_CLOEXEC);
      if (conn < 0) continue;
      struct ucred cr; socklen_t cl = sizeof cr;
      if (getsockopt(conn, SOL_SOCKET, SO_PEERCRED, &cr, &cl) != 0 || cr.uid != su) {
        if (refused++ < 20) fprintf(stderr, "aura-term-launch: refused a request from uid %u (only the server's)\n", (unsigned)cr.uid);
        close(conn);
        continue;
      }
      pid_t h = fork();
      if (h == 0) {
        close(ls); close(sfd);
        sigprocmask(SIG_SETMASK, &old, NULL);
        serve_request(conn, uu, ug);
        _exit(125);
      }
      close(conn);
    }
  }
}

/* ── run: the client, as the service uid ─────────────────────────────────── */

static int g_conn = -1;
static void forward(int sig) { unsigned char b = (unsigned char)sig; (void)!write(g_conn, &b, 1); }

static int add(char **buf, size_t *len, size_t *cap, const char *s) {
  size_t n = strlen(s) + 1;
  if (*len + n > MAX_PAYLOAD) return -1;
  if (*len + n > *cap) {
    size_t nc = *cap ? *cap * 2 : 65536;
    while (nc < *len + n) nc *= 2;
    char *nb = realloc(*buf, nc);
    if (!nb) return -1;
    *buf = nb; *cap = nc;
  }
  memcpy(*buf + *len, s, n); *len += n;
  return 0;
}

static int run(int argc, char **argv) {
  if (argc < 1 || !argv[0][0]) die(125, "%srun: no command", NULL);
  int s = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  struct sockaddr_un a; socklen_t al = sock_addr(&a);
  if (s < 0 || connect(s, (struct sockaddr *)&a, al) != 0) die(125, "the session launcher is not reachable: %s", strerror(errno));
  g_conn = s;

  uint32_t flags = 0;
  if (isatty(0)) {
    flags |= F_TTY;
    /* Give the PTY up as our controlling terminal: the command takes it (a tty has one session). */
    signal(SIGHUP, SIG_IGN);
    if (tcgetsid(0) == getsid(0)) (void)ioctl(0, TIOCNOTTY);
  }

  char *buf = NULL; size_t len = 0, cap = 0;
  char cwd[PATH_MAX], n[32];
  if (!getcwd(cwd, sizeof cwd)) snprintf(cwd, sizeof cwd, "/");
  snprintf(n, sizeof n, "%d", argc);
  int bad = add(&buf, &len, &cap, cwd) || add(&buf, &len, &cap, n);
  for (int i = 0; i < argc && !bad; i++) bad = add(&buf, &len, &cap, argv[i]);
  for (char **e = environ; e && *e && !bad; e++) bad = add(&buf, &len, &cap, *e);
  if (bad) die(125, "%srun: the command or its environment is too large", NULL);

  struct req_head h = { MAGIC, flags, (uint32_t)len };
  int fds[3] = { 0, 1, 2 };
  char cbuf[CMSG_SPACE(sizeof fds)];
  memset(cbuf, 0, sizeof cbuf);
  struct iovec iov = { &h, sizeof h };
  struct msghdr m = { .msg_iov = &iov, .msg_iovlen = 1, .msg_control = cbuf, .msg_controllen = sizeof cbuf };
  struct cmsghdr *c = CMSG_FIRSTHDR(&m);
  c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(sizeof fds);
  memcpy(CMSG_DATA(c), fds, sizeof fds);
  ssize_t r;
  do r = sendmsg(s, &m, MSG_NOSIGNAL); while (r < 0 && errno == EINTR);
  if (r != (ssize_t)sizeof h || write_full(s, buf, len) != 0) die(125, "the session launcher refused the request: %s", strerror(errno));
  free(buf);

  /* The command has our stdio now; we keep none of it (a pipe's reader sees EOF when the command ends). */
  int null = open("/dev/null", O_RDWR | O_CLOEXEC);
  if (null >= 0) { dup2(null, 0); dup2(null, 1); dup2(null, 2); if (null > 2) close(null); }
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = forward;
  sa.sa_flags = SA_RESTART;
  sigemptyset(&sa.sa_mask);
  int fw[] = { SIGHUP, SIGINT, SIGQUIT, SIGTERM, SIGUSR1, SIGUSR2 };
  for (size_t i = 0; i < sizeof fw / sizeof fw[0]; i++) sigaction(fw[i], &sa, NULL);
  signal(SIGPIPE, SIG_IGN);

  int32_t st;
  if (read_full(s, &st, sizeof st) != (ssize_t)sizeof st) _exit(125);
  if (WIFEXITED(st)) _exit(WEXITSTATUS(st));
  if (WIFSIGNALED(st)) {
    int sig = WTERMSIG(st);
    signal(sig, SIG_DFL);
    sigset_t un; sigemptyset(&un); sigaddset(&un, sig); sigprocmask(SIG_UNBLOCK, &un, NULL);
    raise(sig);
    _exit(128 + sig);
  }
  _exit(125);
}

int main(int argc, char **argv) {
  const char *self = strrchr(argv[0], '/');
  self = self ? self + 1 : argv[0];
  if (!strcmp(self, "aura-term-tmux")) {
    char **v = calloc((size_t)argc + 1, sizeof *v);
    if (!v) return 125;
    v[0] = "tmux";
    for (int i = 1; i < argc; i++) v[i] = argv[i];
    return run(argc, v);
  }
  if (argc >= 2 && !strcmp(argv[1], "serve")) return serve(argc, argv);
  if (argc >= 3 && !strcmp(argv[1], "run")) {
    int i = 2;
    if (!strcmp(argv[i], "--")) i++;
    return run(argc - i, argv + i);
  }
  if (argc >= 2 && !strcmp(argv[1], "version")) { puts("aura-term-launch 1"); return 0; }
  fprintf(stderr, "usage: aura-term-launch serve --service UID:GID --user UID:GID -- CMD... | run [--] PROG [ARG...]\n");
  return 125;
}
