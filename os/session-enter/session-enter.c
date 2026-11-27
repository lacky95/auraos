/*
 * aura-session-enter: the privileged launcher of an in-environment session
 * (Phase 5 stream J, D74, phase5-plan.md J.2).
 *
 * Runs as root in the session broker container (`aura-session-broker`:
 * --privileged --pid=host --cgroupns=host --network none, the data volume at
 * /data), started by the shell through one Engine API exec. It never runs a
 * session in the broker: it enters the RUNNING app container's namespaces,
 * gives the session its own mount namespace there, drops to the session's
 * identity and executes the session's command. Its only input is the spec the
 * shell built from its session record (JSON, argv[2]); nothing comes from the
 * user or the CLI.
 *
 *   aura-session-enter enter '<spec>'   open one session (stdio = the exec's)
 *   aura-session-enter end <pid>        end the session whose launcher is <pid>
 *   aura-session-enter reap [<pid>...]  end every launcher except the listed ones
 *   aura-session-enter check '<spec>'   validate a spec only (tests)
 *   aura-session-enter version
 *
 * enter, in order (J.2):
 *   1  pin the target: pidfd_open(init pid), check that it is in the
 *      container's cgroup (no PID-reuse race), refuse a root init for a user
 *      session (J.5), clone the Private Home (open_tree) while the host view
 *      is still there, open the container's cgroup.procs, copy the init's
 *      seccomp filters (PTRACE_SECCOMP_GET_FILTER) and read its AppArmor
 *      profile;
 *   2  setns(pidfd, cgroup|ipc|uts|net|pid|mnt): the app's own namespaces;
 *      hidepid=invisible on the app's /proc (the app never sees a session);
 *   3  unshare(CLONE_NEWNS), / made rslave: binds added to the app later
 *      still arrive, nothing from the session goes back;
 *   4  the home: private = the cloned Private Home on /home/aura, ephemeral =
 *      a tmpfs, app = the app's own App Home (nothing to do);
 *   5  /run/aura-session (tmpfs, the session's TMPDIR); the session's passwd
 *      and group bound read-only over /etc/passwd and /etc/group; a root
 *      session also gets the Docker socket and the docker CLI (J.6);
 *   6  fork: the child is in the app's PID namespace; it mounts its own
 *      procfs (Docker's masked paths re-applied) and joins the app's cgroup;
 *   7  a pty from the app's devpts (TIOCGPTPEER), owned by the session;
 *   8  drop: AppArmor exec profile, groups, gid, uid, every capability set
 *      (a root session keeps Docker's default set), no_new_privs, the app's
 *      seccomp filters;
 *   9  relay between the exec's stdio and the pty, exec the command.
 * Every mount is made through file descriptors opened with O_NOFOLLOW, so a
 * symbolic link planted by the app never redirects one.
 *
 * Exit status: the command's, 128+n for a signal, 125 when the session could
 * not be set up (nothing ran).
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <sys/wait.h>

#define VERSION "1"
#define SETUP_FAILED 125

#ifndef OPEN_TREE_CLONE
#define OPEN_TREE_CLONE 1
#endif
#ifndef OPEN_TREE_CLOEXEC
#define OPEN_TREE_CLOEXEC O_CLOEXEC
#endif
#ifndef MOVE_MOUNT_F_EMPTY_PATH
#define MOVE_MOUNT_F_EMPTY_PATH 0x00000004
#endif
#ifndef MOVE_MOUNT_T_EMPTY_PATH
#define MOVE_MOUNT_T_EMPTY_PATH 0x00000040
#endif
#ifndef FSOPEN_CLOEXEC
#define FSOPEN_CLOEXEC 1
#endif
#ifndef FSMOUNT_CLOEXEC
#define FSMOUNT_CLOEXEC 1
#endif
#ifndef FSCONFIG_SET_STRING
#define FSCONFIG_SET_STRING 1
#endif
#ifndef FSCONFIG_CMD_CREATE
#define FSCONFIG_CMD_CREATE 6
#endif
#ifndef MOUNT_ATTR_RDONLY
#define MOUNT_ATTR_RDONLY 0x00000001
#define MOUNT_ATTR_NOSUID 0x00000002
#define MOUNT_ATTR_NODEV 0x00000004
#define MOUNT_ATTR_NOEXEC 0x00000008
#endif
#ifndef AT_RECURSIVE
#define AT_RECURSIVE 0x8000
#endif
#ifndef PTRACE_SECCOMP_GET_FILTER
#define PTRACE_SECCOMP_GET_FILTER 0x420c
#endif
#ifndef TIOCGPTPEER
#define TIOCGPTPEER _IO('T', 0x41)
#endif
#ifndef CLONE_NEWCGROUP
#define CLONE_NEWCGROUP 0x02000000
#endif

struct mount_attr_s { uint64_t attr_set, attr_clr, propagation, userns_fd; };

static int sys_pidfd_open(pid_t pid) { return (int)syscall(SYS_pidfd_open, pid, 0); }
static int sys_open_tree(int dfd, const char *path, unsigned flags) { return (int)syscall(SYS_open_tree, dfd, path, flags); }
static int sys_move_mount(int fdf, const char *pf, int fdt, const char *pt, unsigned flags) { return (int)syscall(SYS_move_mount, fdf, pf, fdt, pt, flags); }
static int sys_fsopen(const char *fs, unsigned flags) { return (int)syscall(SYS_fsopen, fs, flags); }
static int sys_fsconfig(int fd, unsigned cmd, const char *key, const void *val, int aux) { return (int)syscall(SYS_fsconfig, fd, cmd, key, val, aux); }
static int sys_fsmount(int fd, unsigned flags, unsigned attrs) { return (int)syscall(SYS_fsmount, fd, flags, attrs); }
static int sys_mount_setattr(int dfd, const char *path, unsigned flags, struct mount_attr_s *a) { return (int)syscall(SYS_mount_setattr, dfd, path, flags, a, sizeof *a); }

static void die(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  fputs("aura-session-enter: ", stderr);
  vfprintf(stderr, fmt, ap);
  if (errno) fprintf(stderr, ": %s", strerror(errno));
  fputc('\n', stderr);
  va_end(ap);
  _exit(SETUP_FAILED);
}

/* ─── a small JSON reader (the shell's spec only) ─────────────────────────── */

enum { J_NULL, J_BOOL, J_NUM, J_STR, J_ARR, J_OBJ };
typedef struct jv { int t; long long n; int b; char *s; size_t count; struct jv **items; char **keys; } jv;
static const char *jp;

static void jws(void) { while (*jp == ' ' || *jp == '\t' || *jp == '\n' || *jp == '\r') jp++; }
static jv *jnew(int t) { jv *v = calloc(1, sizeof *v); if (!v) die("out of memory"); v->t = t; return v; }
static void jbad(void) { errno = 0; die("bad spec (JSON)"); }

static void put_utf8(char **o, unsigned cp) {
  char *p = *o;
  if (cp < 0x80) *p++ = (char)cp;
  else if (cp < 0x800) { *p++ = (char)(0xC0 | (cp >> 6)); *p++ = (char)(0x80 | (cp & 0x3F)); }
  else if (cp < 0x10000) { *p++ = (char)(0xE0 | (cp >> 12)); *p++ = (char)(0x80 | ((cp >> 6) & 0x3F)); *p++ = (char)(0x80 | (cp & 0x3F)); }
  else { *p++ = (char)(0xF0 | (cp >> 18)); *p++ = (char)(0x80 | ((cp >> 12) & 0x3F)); *p++ = (char)(0x80 | ((cp >> 6) & 0x3F)); *p++ = (char)(0x80 | (cp & 0x3F)); }
  *o = p;
}

static unsigned hex4(void) {
  unsigned v = 0;
  for (int i = 0; i < 4; i++) {
    char c = *jp++;
    v <<= 4;
    if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
    else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
    else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
    else jbad();
  }
  return v;
}

static char *jstring(void) {
  if (*jp != '"') jbad();
  jp++;
  char *out = malloc(strlen(jp) * 4 + 1), *o = out;
  if (!out) die("out of memory");
  for (;;) {
    char c = *jp++;
    if (c == '"') break;
    if (c == '\0' || (unsigned char)c < 0x20) jbad();
    if (c != '\\') { *o++ = c; continue; }
    c = *jp++;
    switch (c) {
      case '"': *o++ = '"'; break;
      case '\\': *o++ = '\\'; break;
      case '/': *o++ = '/'; break;
      case 'b': *o++ = '\b'; break;
      case 'f': *o++ = '\f'; break;
      case 'n': *o++ = '\n'; break;
      case 'r': *o++ = '\r'; break;
      case 't': *o++ = '\t'; break;
      case 'u': {
        unsigned cp = hex4();
        if (cp >= 0xD800 && cp < 0xDC00) {
          if (jp[0] != '\\' || jp[1] != 'u') jbad();
          jp += 2;
          unsigned lo = hex4();
          if (lo < 0xDC00 || lo > 0xDFFF) jbad();
          cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
        } else if (cp >= 0xDC00 && cp < 0xE000) jbad();
        if (cp == 0) jbad(); /* never a NUL inside a string */
        put_utf8(&o, cp);
        break;
      }
      default: jbad();
    }
  }
  *o = '\0';
  return out;
}

static jv *jvalue(int depth) {
  if (depth > 8) jbad();
  jws();
  jv *v;
  if (*jp == '{' || *jp == '[') {
    int obj = *jp == '{';
    v = jnew(obj ? J_OBJ : J_ARR);
    jp++;
    jws();
    if (*jp == (obj ? '}' : ']')) { jp++; return v; }
    for (;;) {
      jws();
      char *key = NULL;
      if (obj) { key = jstring(); jws(); if (*jp++ != ':') jbad(); }
      jv *item = jvalue(depth + 1);
      v->items = realloc(v->items, (v->count + 1) * sizeof *v->items);
      v->keys = realloc(v->keys, (v->count + 1) * sizeof *v->keys);
      if (!v->items || !v->keys) die("out of memory");
      v->items[v->count] = item;
      v->keys[v->count] = key;
      v->count++;
      jws();
      if (*jp == ',') { jp++; continue; }
      if (*jp == (obj ? '}' : ']')) { jp++; return v; }
      jbad();
    }
  }
  if (*jp == '"') { v = jnew(J_STR); v->s = jstring(); return v; }
  if (!strncmp(jp, "true", 4)) { jp += 4; v = jnew(J_BOOL); v->b = 1; return v; }
  if (!strncmp(jp, "false", 5)) { jp += 5; v = jnew(J_BOOL); return v; }
  if (!strncmp(jp, "null", 4)) { jp += 4; return jnew(J_NULL); }
  if (*jp == '-' || isdigit((unsigned char)*jp)) {
    char *end;
    errno = 0;
    long long n = strtoll(jp, &end, 10);
    if (errno || end == jp || *end == '.' || *end == 'e' || *end == 'E') jbad();
    jp = end;
    v = jnew(J_NUM);
    v->n = n;
    return v;
  }
  jbad();
  return NULL;
}

static jv *jget(const jv *o, const char *key) {
  if (!o || o->t != J_OBJ) return NULL;
  for (size_t i = 0; i < o->count; i++) if (!strcmp(o->keys[i], key)) return o->items[i];
  return NULL;
}
static const char *jstr(const jv *o, const char *key, int required) {
  jv *v = jget(o, key);
  if (!v || v->t == J_NULL) { if (required) { errno = 0; die("spec: %s is required", key); } return NULL; }
  if (v->t != J_STR) { errno = 0; die("spec: %s must be a string", key); }
  return v->s;
}
static long long jnum(const jv *o, const char *key, long long min, long long max) {
  jv *v = jget(o, key);
  if (!v || v->t != J_NUM || v->n < min || v->n > max) { errno = 0; die("spec: %s must be a number in range", key); }
  return v->n;
}
static int jbool(const jv *o, const char *key) { jv *v = jget(o, key); return v && v->t == J_BOOL && v->b; }
/* A NULL-terminated string list; `required` refuses an empty one. */
static char **jstrv(const jv *o, const char *key, int required) {
  jv *v = jget(o, key);
  if (!v || v->t == J_NULL) { if (required) { errno = 0; die("spec: %s is required", key); } char **e = calloc(1, sizeof *e); return e; }
  if (v->t != J_ARR || (required && v->count == 0) || v->count > 4096) { errno = 0; die("spec: %s must be a list of strings", key); }
  char **out = calloc(v->count + 1, sizeof *out);
  if (!out) die("out of memory");
  for (size_t i = 0; i < v->count; i++) {
    if (v->items[i]->t != J_STR) { errno = 0; die("spec: %s must be a list of strings", key); }
    out[i] = v->items[i]->s;
  }
  return out;
}

/* ─── the spec ────────────────────────────────────────────────────────────── */

enum { KIND_USER, KIND_APP, KIND_ROOT };
enum { HOME_PRIVATE, HOME_APP, HOME_EPHEMERAL };

struct spec {
  const char *sid, *container, *cwd, *passwd, *group, *home_path, *socket, *docker_cli;
  pid_t pid;
  int kind, home, tty;
  uid_t uid;
  gid_t gid;
  uid_t session_host_uid;   /* a System Terminal's own user (0: not a session host) */
  gid_t groups[32];
  int ngroups;
  char **env, **argv;
};

static int valid_hex_id(const char *s) {
  size_t n = strlen(s);
  if (n != 64) return 0;
  for (size_t i = 0; i < n; i++) if (!isxdigit((unsigned char)s[i]) || isupper((unsigned char)s[i])) return 0;
  return 1;
}
static int valid_abs_path(const char *s) {
  if (!s || s[0] != '/') return 0;
  size_t n = strlen(s);
  if (n >= 4096 || strstr(s, "/../") || strstr(s, "/./")) return 0;
  return !(n >= 3 && !strcmp(s + n - 3, "/..")) && !(n >= 2 && !strcmp(s + n - 2, "/."));
}

static void read_spec(const char *json, struct spec *sp) {
  memset(sp, 0, sizeof *sp);
  jp = json;
  jv *o = jvalue(0);
  jws();
  if (*jp || o->t != J_OBJ) jbad();
  if (jnum(o, "v", 1, 1) != 1) jbad();
  sp->sid = jstr(o, "sid", 1);
  sp->container = jstr(o, "container", 1);
  if (!valid_hex_id(sp->container)) { errno = 0; die("spec: container must be a full container id"); }
  sp->pid = (pid_t)jnum(o, "pid", 2, 4194304);
  const char *kind = jstr(o, "kind", 1);
  sp->kind = !strcmp(kind, "user") ? KIND_USER : !strcmp(kind, "app") ? KIND_APP : !strcmp(kind, "root") ? KIND_ROOT : -1;
  if (sp->kind < 0) { errno = 0; die("spec: unknown kind %s", kind); }
  const char *home = jstr(o, "home", 1);
  sp->home = !strcmp(home, "private") ? HOME_PRIVATE : !strcmp(home, "app") ? HOME_APP : !strcmp(home, "ephemeral") ? HOME_EPHEMERAL : -1;
  if (sp->home < 0) { errno = 0; die("spec: unknown home %s", home); }
  sp->home_path = jstr(o, "homePath", sp->home == HOME_PRIVATE);
  if (sp->home == HOME_PRIVATE && !valid_abs_path(sp->home_path)) { errno = 0; die("spec: homePath must be an absolute path"); }
  sp->uid = (uid_t)jnum(o, "uid", 0, 0x7ffffffe);
  sp->gid = (gid_t)jnum(o, "gid", 0, 0x7ffffffe);
  jv *g = jget(o, "groups");
  if (g && g->t == J_ARR) {
    if (g->count > 32) { errno = 0; die("spec: too many groups"); }
    for (size_t i = 0; i < g->count; i++) {
      if (g->items[i]->t != J_NUM || g->items[i]->n < 0 || g->items[i]->n > 0x7ffffffe) jbad();
      sp->groups[sp->ngroups++] = (gid_t)g->items[i]->n;
    }
  }
  /* A user session is never root, and a user's home is never in a root session (J.5, P5-2). */
  if (sp->kind == KIND_USER && (sp->uid == 0 || sp->gid == 0)) { errno = 0; die("spec: a user session never runs as root"); }
  if (sp->kind == KIND_USER) for (int i = 0; i < sp->ngroups; i++) if (sp->groups[i] == 0) { errno = 0; die("spec: a user session never has group 0"); }
  if (sp->kind == KIND_ROOT && (sp->uid != 0 || sp->gid != 0)) { errno = 0; die("spec: a root session runs as 0:0"); }
  if (sp->kind == KIND_APP && sp->home != HOME_APP) { errno = 0; die("spec: an app session has the App Home"); }
  if (sp->kind != KIND_APP && sp->home == HOME_APP) { errno = 0; die("spec: the App Home is the app identity's"); }
  /* A System Terminal (stream T2) runs its launcher as root: its own user, and only they, may enter it. */
  jv *sh = jget(o, "sessionHostUid");
  if (sh) sp->session_host_uid = (uid_t)jnum(o, "sessionHostUid", 1, 0x7ffffffe);
  sp->cwd = jstr(o, "cwd", 0);
  if (sp->cwd && !valid_abs_path(sp->cwd)) { errno = 0; die("spec: cwd must be an absolute path"); }
  sp->passwd = jstr(o, "passwd", 0);
  sp->group = jstr(o, "group", 0);
  sp->socket = jstr(o, "socket", 0);
  sp->docker_cli = jstr(o, "dockerCli", 0);
  if ((sp->socket || sp->docker_cli) && sp->kind != KIND_ROOT) { errno = 0; die("spec: the Docker socket is a root session's only"); }
  if (sp->socket && !valid_abs_path(sp->socket)) jbad();
  if (sp->docker_cli && !valid_abs_path(sp->docker_cli)) jbad();
  sp->tty = jbool(o, "tty");
  sp->env = jstrv(o, "env", 0);
  for (char **e = sp->env; *e; e++) if (!strchr(*e, '=') || **e == '=') { errno = 0; die("spec: env entries are KEY=value"); }
  sp->argv = jstrv(o, "argv", 1);
}

/* ─── helpers ─────────────────────────────────────────────────────────────── */

static char *read_file(const char *path, size_t max) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return NULL;
  char *buf = malloc(max + 1);
  if (!buf) die("out of memory");
  size_t n = 0;
  for (;;) {
    ssize_t r = read(fd, buf + n, max - n);
    if (r < 0) { if (errno == EINTR) continue; free(buf); close(fd); return NULL; }
    if (r == 0 || (n += (size_t)r) >= max) break;
  }
  buf[n] = '\0';
  close(fd);
  return buf;
}

static void write_all(int fd, const char *data, size_t len) {
  while (len) {
    ssize_t w = write(fd, data, len);
    if (w < 0) { if (errno == EINTR) continue; die("write"); }
    data += w;
    len -= (size_t)w;
  }
}

/* The cgroup v2 path of a process, as seen from this cgroup namespace (the host's: --cgroupns=host). */
static char *cgroup_of(pid_t pid) {
  char path[64];
  snprintf(path, sizeof path, "/proc/%d/cgroup", (int)pid);
  char *text = read_file(path, 8192);
  if (!text) return NULL;
  for (char *line = strtok(text, "\n"); line; line = strtok(NULL, "\n")) {
    if (!strncmp(line, "0::", 3)) { char *r = strdup(line + 3); free(text); return r; }
  }
  free(text);
  return NULL;
}

/* An existing directory or file of this mount namespace, without following a final symbolic link. */
static int open_target(const char *path, int dir) {
  int fd = open(path, O_PATH | O_NOFOLLOW | O_CLOEXEC | (dir ? O_DIRECTORY : 0));
  if (fd < 0) die("%s", path);
  struct stat st;
  if (fstat(fd, &st) < 0) die("stat %s", path);
  if (dir ? !S_ISDIR(st.st_mode) : !(S_ISREG(st.st_mode) || S_ISSOCK(st.st_mode) || S_ISCHR(st.st_mode))) { errno = 0; die("%s has the wrong type", path); }
  return fd;
}

/* Attach a detached mount (open_tree/fsmount) onto an O_PATH target. */
static void attach(int mfd, int target, const char *what) {
  if (sys_move_mount(mfd, "", target, "", MOVE_MOUNT_F_EMPTY_PATH | MOVE_MOUNT_T_EMPTY_PATH) < 0) die("mount %s", what);
  close(mfd);
}

/* A read-only bind of `src` (a path of this namespace) over `dst`. */
static void bind_ro(const char *src, const char *dst, int dir) {
  int target = open(dst, O_PATH | O_NOFOLLOW | O_CLOEXEC);
  if (target < 0) { if (errno == ENOENT) return; die("%s", dst); }
  struct stat st;
  if (fstat(target, &st) < 0 || (dir && !S_ISDIR(st.st_mode)) || S_ISLNK(st.st_mode)) { close(target); return; }
  int mfd = sys_open_tree(AT_FDCWD, src, OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_SYMLINK_NOFOLLOW);
  if (mfd < 0) die("clone %s", src);
  struct mount_attr_s a = { .attr_set = MOUNT_ATTR_RDONLY | MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV };
  if (sys_mount_setattr(mfd, "", AT_EMPTY_PATH, &a) < 0) die("read-only %s", dst);
  attach(mfd, target, dst);
  close(target);
}

/* A fresh tmpfs over an existing directory. */
static void tmpfs_on(const char *dst, const char *opts_mode, uid_t uid, gid_t gid, const char *size, int ro) {
  int target = open_target(dst, 1);
  int fs = sys_fsopen("tmpfs", FSOPEN_CLOEXEC);
  if (fs < 0) die("tmpfs");
  char num[32];
  if (sys_fsconfig(fs, FSCONFIG_SET_STRING, "mode", opts_mode, 0) < 0) die("tmpfs mode");
  snprintf(num, sizeof num, "%u", (unsigned)uid);
  if (sys_fsconfig(fs, FSCONFIG_SET_STRING, "uid", num, 0) < 0) die("tmpfs uid");
  snprintf(num, sizeof num, "%u", (unsigned)gid);
  if (sys_fsconfig(fs, FSCONFIG_SET_STRING, "gid", num, 0) < 0) die("tmpfs gid");
  if (sys_fsconfig(fs, FSCONFIG_SET_STRING, "size", size, 0) < 0) die("tmpfs size");
  if (sys_fsconfig(fs, FSCONFIG_CMD_CREATE, NULL, NULL, 0) < 0) die("tmpfs create");
  int mfd = sys_fsmount(fs, FSMOUNT_CLOEXEC, MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV | (ro ? MOUNT_ATTR_RDONLY : 0));
  if (mfd < 0) die("tmpfs mount");
  close(fs);
  attach(mfd, target, dst);
  close(target);
}

/* ─── 1: pin the target ───────────────────────────────────────────────────── */

struct pinned {
  int pidfd, cgroup_procs, home_tree, socket_tree, cli_tree;
  struct sock_fprog filters[8];
  int nfilters;
  char apparmor[256];
};

/* The init's seccomp filters, oldest first; the session gets exactly the app's filter class. */
static int copy_seccomp(pid_t pid, struct sock_fprog *out, int max) {
  if (ptrace(PTRACE_SEIZE, pid, 0, 0) < 0) die("ptrace seize the app's init (seccomp copy)");
  if (ptrace(PTRACE_INTERRUPT, pid, 0, 0) < 0) die("ptrace interrupt");
  int st;
  if (waitpid(pid, &st, __WALL) < 0) die("wait for the app's init");
  struct sock_fprog tmp[8];
  int n = 0;
  for (; n < max && n < 8; n++) {
    long len = ptrace(PTRACE_SECCOMP_GET_FILTER, pid, (void *)(long)n, NULL);
    if (len < 0) { if (errno == ENOENT) break; int e = errno; ptrace(PTRACE_DETACH, pid, 0, 0); errno = e; die("read the app's seccomp filter"); }
    struct sock_filter *insns = calloc((size_t)len, sizeof *insns);
    if (!insns) die("out of memory");
    if (ptrace(PTRACE_SECCOMP_GET_FILTER, pid, (void *)(long)n, insns) != len) { int e = errno; ptrace(PTRACE_DETACH, pid, 0, 0); errno = e; die("read the app's seccomp filter"); }
    tmp[n].len = (unsigned short)len;
    tmp[n].filter = insns;
  }
  ptrace(PTRACE_DETACH, pid, 0, 0);
  /* Index 0 is the newest; install the oldest first. */
  for (int i = 0; i < n; i++) out[i] = tmp[n - 1 - i];
  return n;
}

static void pin(const struct spec *sp, struct pinned *pn) {
  memset(pn, 0, sizeof *pn);
  pn->home_tree = pn->socket_tree = pn->cli_tree = -1;
  pn->pidfd = sys_pidfd_open(sp->pid);
  if (pn->pidfd < 0) die("the app's init process (pid %d)", (int)sp->pid);
  /* After pidfd_open: the pid can no longer be reused under us, so this check is final. */
  char *cg = cgroup_of(sp->pid);
  if (!cg || !strstr(cg, sp->container)) { errno = 0; die("pid %d is not the container's process (cgroup %s)", (int)sp->pid, cg ? cg : "?"); }
  if (syscall(SYS_pidfd_send_signal, pn->pidfd, 0, NULL, 0) < 0) die("the app's init is gone");
  /* J.5: a user's session never enters an app whose init runs as root. */
  char status_path[64];
  snprintf(status_path, sizeof status_path, "/proc/%d/status", (int)sp->pid);
  char *status = read_file(status_path, 16384);
  if (!status) die("read the app's init status");
  char *uidline = strstr(status, "\nUid:");
  if (!uidline) { errno = 0; die("no Uid in the app's init status"); }
  unsigned ruid = 0, euid = 0;
  if (sscanf(uidline + 5, "%u %u", &ruid, &euid) != 2) { errno = 0; die("bad Uid line"); }
  /* T2: a session host's init is root (its session launcher, SETUID/SETGID only); its own user's session may enter it. */
  int own_terminal = sp->session_host_uid != 0 && sp->kind == KIND_USER && sp->uid == sp->session_host_uid;
  if (sp->kind == KIND_USER && (ruid == 0 || euid == 0) && !own_terminal) { errno = 0; die("the app runs as root: a user session is refused (capability-missing: identity)"); }
  free(status);

  char procs[4200];
  if (snprintf(procs, sizeof procs, "/sys/fs/cgroup%s/cgroup.procs", cg) >= (int)sizeof procs) { errno = 0; die("cgroup path too long"); }
  /* Opened here, in the host's cgroup namespace: the write after setns is checked against this view. */
  pn->cgroup_procs = open(procs, O_WRONLY | O_CLOEXEC);
  if (pn->cgroup_procs < 0) die("open %s", procs);
  free(cg);

  if (sp->home == HOME_PRIVATE) {
    pn->home_tree = sys_open_tree(AT_FDCWD, sp->home_path, OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_RECURSIVE | AT_SYMLINK_NOFOLLOW);
    if (pn->home_tree < 0) die("the Private Home");
    struct stat st;
    if (fstat(pn->home_tree, &st) < 0 || !S_ISDIR(st.st_mode)) { errno = 0; die("the Private Home is not a directory"); }
  }
  if (sp->socket) {
    pn->socket_tree = sys_open_tree(AT_FDCWD, sp->socket, OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_SYMLINK_NOFOLLOW);
    if (pn->socket_tree < 0) die("the Docker socket");
  }
  if (sp->docker_cli) {
    pn->cli_tree = sys_open_tree(AT_FDCWD, sp->docker_cli, OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_SYMLINK_NOFOLLOW);
    if (pn->cli_tree < 0) die("the docker CLI");
    struct mount_attr_s a = { .attr_set = MOUNT_ATTR_RDONLY | MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV };
    if (sys_mount_setattr(pn->cli_tree, "", AT_EMPTY_PATH, &a) < 0) die("read-only docker CLI");
  }

  pn->nfilters = copy_seccomp(sp->pid, pn->filters, 8);
  if (pn->nfilters == 0) { errno = 0; die("the app container has no seccomp filter; refusing a session without one"); }

  /* The init's AppArmor profile ("docker-default (enforce)"); none on a host without AppArmor. */
  char attr[64];
  snprintf(attr, sizeof attr, "/proc/%d/attr/apparmor/current", (int)sp->pid);
  char *cur = read_file(attr, 255);
  if (!cur) { snprintf(attr, sizeof attr, "/proc/%d/attr/current", (int)sp->pid); cur = read_file(attr, 255); }
  if (cur) {
    char *sp_ = strstr(cur, " (");
    if (sp_) *sp_ = '\0';
    char *nl = strchr(cur, '\n');
    if (nl) *nl = '\0';
    if (*cur && strcmp(cur, "unconfined")) snprintf(pn->apparmor, sizeof pn->apparmor, "%s", cur);
    free(cur);
  }
}

/* ─── 2–5: the app's namespaces, then the session's own mount namespace ───── */

static void hide_app_proc(void) {
  /* Idempotent: the app's /proc keeps its flags and gains hidepid=invisible. */
  struct statvfs sv;
  if (statvfs("/proc", &sv) < 0) die("statvfs /proc");
  unsigned long flags = MS_REMOUNT;
  if (sv.f_flag & ST_NOSUID) flags |= MS_NOSUID;
  if (sv.f_flag & ST_NODEV) flags |= MS_NODEV;
  if (sv.f_flag & ST_NOEXEC) flags |= MS_NOEXEC;
  if (sv.f_flag & ST_RDONLY) flags |= MS_RDONLY;
  if (mount(NULL, "/proc", NULL, flags, "hidepid=invisible") < 0) die("hidepid on the app's /proc");
}

static void enter_and_isolate(const struct spec *sp, struct pinned *pn) {
  if (setns(pn->pidfd, CLONE_NEWCGROUP | CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWNET | CLONE_NEWPID | CLONE_NEWNS) < 0) {
    die("enter the app's namespaces");
  }
  if (chdir("/") < 0) die("chdir /");
  hide_app_proc();
  if (unshare(CLONE_NEWNS) < 0) die("a mount namespace of its own");
  if (mount(NULL, "/", NULL, MS_REC | MS_SLAVE, NULL) < 0) die("make / rslave");

  if (sp->home == HOME_PRIVATE) {
    int target = open_target("/home/aura", 1);
    attach(pn->home_tree, target, "the Private Home");
    close(target);
    pn->home_tree = -1;
  } else if (sp->home == HOME_EPHEMERAL) {
    tmpfs_on("/home/aura", "0700", sp->uid, sp->gid, "512m", 0);
  }

  /* /run/aura-session: an empty root-owned mount point in the app (created once), a tmpfs in the session. */
  if (mkdir("/run/aura-session", 0755) < 0 && errno != EEXIST) die("mkdir /run/aura-session");
  tmpfs_on("/run/aura-session", "0700", sp->uid, sp->gid, "64m", 0);

  int run = open("/run/aura-session", O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (run < 0) die("/run/aura-session");
  const char *files[2][2] = { { ".passwd", sp->passwd }, { ".group", sp->group } };
  const char *over[2] = { "/etc/passwd", "/etc/group" };
  for (int i = 0; i < 2; i++) {
    if (!files[i][1]) continue;
    char path[64];
    snprintf(path, sizeof path, "/run/aura-session/%s", files[i][0]);
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0444);
    if (fd < 0) die("%s", path);
    write_all(fd, files[i][1], strlen(files[i][1]));
    if (fchown(fd, 0, 0) < 0 || fchmod(fd, 0444) < 0) die("own %s", path);
    close(fd);
    bind_ro(path, over[i], 0);
  }
  close(run);

  if (pn->socket_tree >= 0) {
    int dir = open("/var/run", O_PATH | O_DIRECTORY | O_CLOEXEC);
    if (dir < 0) die("/var/run");
    int fd = openat(dir, "docker.sock", O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0 && errno != EEXIST) die("/var/run/docker.sock mount point");
    if (fd >= 0) close(fd);
    close(dir);
    int target = open_target("/var/run/docker.sock", 0);
    attach(pn->socket_tree, target, "the Docker socket");
    close(target);
  }
  if (pn->cli_tree >= 0) {
    /* On the session's own tmpfs (its PATH has /run/aura-session/bin): never in the app's tools dir. */
    if (mkdir("/run/aura-session/bin", 0755) < 0) die("/run/aura-session/bin");
    int fd = open("/run/aura-session/bin/docker", O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0755);
    if (fd < 0) die("docker CLI mount point");
    close(fd);
    int target = open_target("/run/aura-session/bin/docker", 0);
    attach(pn->cli_tree, target, "the docker CLI");
    close(target);
  }
}

/* ─── 6: the session's own procfs (in the app's PID namespace) ────────────── */

static void mask(const char *path, int dir) {
  int target = open(path, O_PATH | O_NOFOLLOW | O_CLOEXEC);
  if (target < 0) return; /* not on this kernel */
  struct stat st;
  if (fstat(target, &st) < 0) { close(target); return; }
  if (S_ISDIR(st.st_mode) != !!dir) { close(target); return; }
  close(target);
  if (dir) tmpfs_on(path, "0555", 0, 0, "4k", 1);
  else bind_ro("/dev/null", path, 0);
}

/*
 * The session's own procfs, in the app's PID namespace (D74), hidepid=invisible
 * for user and app sessions: a process is listed only when the reader may
 * ptrace-read it, i.e. its own uid. A user session sees its own session
 * processes and nothing of other users' sessions (no cmdline, status,
 * mountinfo, environ; no signal, ptrace or setns: other uid, no capability).
 * An app session (--home app, the app's uid) sees the app's processes and no
 * user's session. No `gid=` exemption: procfs exempts by the READER's group, so
 * any group that showed a user the app's processes would show them every other
 * user's sessions too (owner answer 1: no shared group that weakens cross-user
 * isolation). The app's processes are inspected with --home app (explicit,
 * authorized, audited). A root tab (its user's own Terminal only) keeps a full
 * procfs: root without CAP_SYS_PTRACE would see nothing of its own Terminal.
 */
static int procfs_hidden(int kind) { return kind != KIND_ROOT; }

static void own_procfs(int hide) {
  int fs = sys_fsopen("proc", FSOPEN_CLOEXEC);
  if (fs < 0) die("procfs");
  if (hide && sys_fsconfig(fs, FSCONFIG_SET_STRING, "hidepid", "invisible", 0) < 0) die("procfs hidepid");
  if (sys_fsconfig(fs, FSCONFIG_CMD_CREATE, NULL, NULL, 0) < 0) die("procfs create");
  int mfd = sys_fsmount(fs, FSMOUNT_CLOEXEC, MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV | MOUNT_ATTR_NOEXEC);
  if (mfd < 0) die("procfs mount");
  close(fs);
  int target = open_target("/proc", 1);
  attach(mfd, target, "/proc");
  close(target);
  /* Docker's masked and read-only paths (moby oci/defaults.go). */
  static const char *masked_files[] = { "/proc/kcore", "/proc/keys", "/proc/latency_stats", "/proc/timer_list", "/proc/timer_stats", "/proc/sched_debug", "/proc/interrupts" };
  static const char *masked_dirs[] = { "/proc/acpi", "/proc/asound", "/proc/scsi" };
  static const char *ro[] = { "/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger" };
  for (size_t i = 0; i < sizeof masked_files / sizeof *masked_files; i++) mask(masked_files[i], 0);
  for (size_t i = 0; i < sizeof masked_dirs / sizeof *masked_dirs; i++) mask(masked_dirs[i], 1);
  for (size_t i = 0; i < sizeof ro / sizeof *ro; i++) {
    struct stat st;
    if (lstat(ro[i], &st) == 0) bind_ro(ro[i], ro[i], S_ISDIR(st.st_mode));
  }
}

/* ─── 8: drop to the session's identity ───────────────────────────────────── */

/* Docker's default capability set (moby oci/caps/defaults.go), without NET_RAW (D89). */
static const int ROOT_CAPS[] = {
  CAP_CHOWN, CAP_DAC_OVERRIDE, CAP_FSETID, CAP_FOWNER, CAP_MKNOD, CAP_SETGID, CAP_SETUID,
  CAP_SETFCAP, CAP_SETPCAP, CAP_NET_BIND_SERVICE, CAP_SYS_CHROOT, CAP_KILL, CAP_AUDIT_WRITE,
};

static int last_cap(void) {
  char *s = read_file("/proc/sys/kernel/cap_last_cap", 16);
  int n = s ? atoi(s) : CAP_LAST_CAP;
  free(s);
  return n > 0 && n < 64 ? n : CAP_LAST_CAP;
}

static void drop(const struct spec *sp, const struct pinned *pn) {
  /* AppArmor: the app's own profile from the next exec on (before no_new_privs). */
  if (pn->apparmor[0]) {
    char cmd[300];
    int n = snprintf(cmd, sizeof cmd, "exec %s", pn->apparmor);
    int fd = open("/proc/self/attr/apparmor/exec", O_WRONLY | O_CLOEXEC);
    if (fd < 0) fd = open("/proc/self/attr/exec", O_WRONLY | O_CLOEXEC);
    if (fd < 0 || write(fd, cmd, (size_t)n) != n) die("AppArmor profile %s", pn->apparmor);
    close(fd);
  }
  unsigned long long keep = 0;
  if (sp->kind == KIND_ROOT) for (size_t i = 0; i < sizeof ROOT_CAPS / sizeof *ROOT_CAPS; i++) keep |= 1ULL << ROOT_CAPS[i];
  int last = last_cap();
  for (int c = 0; c <= last; c++) {
    if (keep & (1ULL << c)) continue;
    if (prctl(PR_CAPBSET_DROP, c, 0, 0, 0) < 0 && errno != EINVAL) die("drop capability %d", c);
  }
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) < 0 && errno != EINVAL) die("clear ambient capabilities");
  if (setgroups((size_t)sp->ngroups, sp->groups) < 0) die("setgroups");
  if (setresgid(sp->gid, sp->gid, sp->gid) < 0) die("setresgid");
  if (setresuid(sp->uid, sp->uid, sp->uid) < 0) die("setresuid");
  struct __user_cap_header_struct hdr = { _LINUX_CAPABILITY_VERSION_3, 0 };
  struct __user_cap_data_struct data[2];
  memset(data, 0, sizeof data);
  data[0].effective = data[0].permitted = data[0].inheritable = (uint32_t)keep;
  data[1].effective = data[1].permitted = data[1].inheritable = (uint32_t)(keep >> 32);
  if (syscall(SYS_capset, &hdr, data) < 0) die("capset");
  if (sp->uid != 0) {
    /* Nothing may bring root back. */
    if (setuid(0) == 0 || seteuid(0) == 0) { errno = 0; die("could regain root"); }
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) die("no_new_privs");
  for (int i = 0; i < pn->nfilters; i++) {
    if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &pn->filters[i]) < 0) die("install the app's seccomp filter");
  }
}

static void run_command(const struct spec *sp) {
  if (sp->cwd && chdir(sp->cwd) < 0 && chdir("/home/aura") < 0 && chdir("/") < 0) die("chdir");
  if (!sp->cwd && chdir("/home/aura") < 0 && chdir("/") < 0) die("chdir");
  execvpe(sp->argv[0], sp->argv, sp->env);
  fprintf(stderr, "aura-session-enter: %s: %s\n", sp->argv[0], strerror(errno));
  _exit(errno == ENOENT ? 127 : 126);
}

/* ─── 9: the relay (TTY sessions) ─────────────────────────────────────────── */

static volatile sig_atomic_t winch = 1;
static void on_winch(int s) { (void)s; winch = 1; }

static int status_code(int st) { return WIFEXITED(st) ? WEXITSTATUS(st) : WIFSIGNALED(st) ? 128 + WTERMSIG(st) : 1; }

static int relay(int master, pid_t child, int parent_alive) {
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_winch;
  sigaction(SIGWINCH, &sa, NULL);
  char buf[16384];
  int in_open = 1;
  for (;;) {
    if (winch) {
      winch = 0;
      struct winsize ws;
      if (ioctl(0, TIOCGWINSZ, &ws) == 0) ioctl(master, TIOCSWINSZ, &ws);
    }
    struct pollfd p[3] = { { master, POLLIN, 0 }, { in_open ? 0 : -1, POLLIN, 0 }, { parent_alive, POLLIN, 0 } };
    int r = poll(p, 3, -1);
    if (r < 0) { if (errno == EINTR) continue; break; }
    if (p[2].revents) break; /* the launcher is gone: the session ends (bridge disconnect, End) */
    if (p[0].revents & (POLLIN | POLLHUP | POLLERR)) {
      ssize_t n = read(master, buf, sizeof buf);
      if (n <= 0) break; /* EIO: the session's terminal has no process left */
      size_t off = 0;
      while (off < (size_t)n) { ssize_t w = write(1, buf + off, (size_t)n - off); if (w < 0) { if (errno == EINTR) continue; goto out; } off += (size_t)w; }
    }
    if (p[1].revents & (POLLIN | POLLHUP | POLLERR)) {
      ssize_t n = read(0, buf, sizeof buf);
      if (n <= 0) in_open = 0;
      else { size_t off = 0; while (off < (size_t)n) { ssize_t w = write(master, buf + off, (size_t)n - off); if (w < 0) { if (errno == EINTR) continue; break; } off += (size_t)w; } }
    }
  }
out:;
  /* Hang up: the session leader gets SIGHUP, then whatever is left gets SIGKILL after 10 s. */
  close(master);
  for (int i = 0; i < 100; i++) {
    int st;
    pid_t w = waitpid(child, &st, WNOHANG);
    if (w == child) { kill(-child, SIGHUP); return status_code(st); }
    if (i == 0) kill(-child, SIGHUP);
    usleep(100000);
  }
  kill(-child, SIGKILL);
  int st;
  waitpid(child, &st, 0);
  return status_code(st);
}

/* ─── enter ───────────────────────────────────────────────────────────────── */

static int cmd_enter(const char *json) {
  struct spec sp;
  read_spec(json, &sp);
  struct pinned pn;
  pin(&sp, &pn);
  enter_and_isolate(&sp, &pn);

  /* The launcher's liveness, for the session side: EOF on this pipe = the launcher was ended. */
  int alive[2];
  if (pipe2(alive, O_CLOEXEC) < 0) die("pipe");
  pid_t child = fork(); /* the child is in the app's PID namespace */
  if (child < 0) die("fork");
  if (child > 0) {
    close(alive[0]);
    close(pn.pidfd);
    close(pn.cgroup_procs);
    signal(SIGHUP, SIG_IGN);
    int st;
    while (waitpid(child, &st, 0) < 0) if (errno != EINTR) return SETUP_FAILED;
    return status_code(st);
  }
  close(alive[1]);
  close(pn.pidfd);
  own_procfs(procfs_hidden(sp.kind));
  if (write(pn.cgroup_procs, "0", 1) != 1) die("join the app's cgroup");
  close(pn.cgroup_procs);

  if (!sp.tty) {
    drop(&sp, &pn);
    prctl(PR_SET_PDEATHSIG, SIGKILL);
    run_command(&sp);
  }

  int master = open("/dev/ptmx", O_RDWR | O_NOCTTY | O_CLOEXEC);
  if (master < 0) die("/dev/ptmx of the app");
  if (unlockpt(master) < 0) die("unlockpt");
  int slave = ioctl(master, TIOCGPTPEER, O_RDWR | O_NOCTTY);
  if (slave < 0) die("the session's pty");
  /* The session's terminal: its user's, group tty, 0620; no app uid is in tty. */
  if (fchown(slave, sp.uid, 5) < 0 || fchmod(slave, 0620) < 0) die("own the session's pty");
  struct winsize ws;
  if (ioctl(0, TIOCGWINSZ, &ws) == 0) ioctl(master, TIOCSWINSZ, &ws);

  pid_t shell = fork();
  if (shell < 0) die("fork");
  if (shell == 0) {
    close(master);
    close(alive[0]);
    if (setsid() < 0) die("setsid");
    if (ioctl(slave, TIOCSCTTY, 0) < 0) die("controlling terminal");
    if (dup2(slave, 0) < 0 || dup2(slave, 1) < 0 || dup2(slave, 2) < 0) die("dup2");
    if (slave > 2) close(slave);
    drop(&sp, &pn);
    run_command(&sp);
  }
  close(slave);
  /* The relay keeps no privilege either; it only moves bytes and sizes. */
  struct spec relay_identity = sp;
  /* A root session's relay stays uid 0 (to end the session's processes) without any capability. */
  if (sp.kind == KIND_ROOT) relay_identity.kind = KIND_APP;
  struct pinned none = pn;
  none.apparmor[0] = '\0';
  drop(&relay_identity, &none);
  prctl(PR_SET_PDEATHSIG, SIGHUP);
  return relay(master, shell, alive[0]);
}

/* ─── end / reap: only launchers of this broker ───────────────────────────── */

static int is_launcher(pid_t pid, const char *own_cgroup) {
  char *cg = cgroup_of(pid);
  int same = cg && !strcmp(cg, own_cgroup);
  free(cg);
  if (!same) return 0;
  char path[64];
  snprintf(path, sizeof path, "/proc/%d/cmdline", (int)pid);
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return 0;
  char buf[512];
  ssize_t n = read(fd, buf, sizeof buf - 1);
  close(fd);
  if (n <= 0) return 0;
  buf[n] = '\0';
  const char *arg1 = buf + strlen(buf) + 1;
  return arg1 < buf + n && !strcmp(arg1, "enter");
}

static int cmd_end(int argc, char **argv, int reap) {
  char *own = cgroup_of(getpid());
  if (!own) die("own cgroup");
  if (!reap) {
    if (argc != 1) { errno = 0; die("usage: end <pid>"); }
    pid_t pid = (pid_t)atoi(argv[0]);
    if (pid <= 1 || !is_launcher(pid, own)) { errno = 0; die("%s is not a session launcher of this broker", argv[0]); }
    return kill(pid, SIGTERM) == 0 ? 0 : 1;
  }
  char procs[4200];
  snprintf(procs, sizeof procs, "/sys/fs/cgroup%s/cgroup.procs", own);
  FILE *f = fopen(procs, "re");
  if (!f) die("%s", procs);
  int pid, ended = 0;
  while (fscanf(f, "%d", &pid) == 1) {
    if (pid == getpid() || pid <= 1) continue;
    int keep = 0;
    for (int i = 0; i < argc; i++) if (atoi(argv[i]) == pid) keep = 1;
    if (!keep && is_launcher(pid, own) && kill(pid, SIGTERM) == 0) { printf("%d\n", pid); ended++; }
  }
  fclose(f);
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 2 && !strcmp(argv[1], "version")) { puts(VERSION); return 0; }
  if (argc == 3 && !strcmp(argv[1], "enter")) {
    if (geteuid() != 0) { errno = 0; die("must run as root in the session broker"); }
    return cmd_enter(argv[2]);
  }
  if (argc == 3 && !strcmp(argv[1], "check")) {
    /* Validate a spec without touching anything (tests, diagnose). */
    struct spec sp;
    read_spec(argv[2], &sp);
    printf("kind=%s home=%s uid=%u gid=%u groups=%d tty=%d argv0=%s socket=%d procfs=%s\n",
      sp.kind == KIND_USER ? "user" : sp.kind == KIND_APP ? "app" : "root",
      sp.home == HOME_PRIVATE ? "private" : sp.home == HOME_APP ? "app" : "ephemeral",
      (unsigned)sp.uid, (unsigned)sp.gid, sp.ngroups, sp.tty, sp.argv[0], sp.socket != NULL,
      procfs_hidden(sp.kind) ? "invisible" : "full");
    return 0;
  }
  if (argc >= 2 && !strcmp(argv[1], "end")) return cmd_end(argc - 2, argv + 2, 0);
  if (argc >= 2 && !strcmp(argv[1], "reap")) return cmd_end(argc - 2, argv + 2, 1);
  fputs("usage: aura-session-enter enter '<spec>' | end <pid> | check '<spec>' | reap [<pid>...] | version\n", stderr);
  return 2;
}
