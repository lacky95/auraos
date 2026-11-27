/*
 * aura-rename-exchange: the atomic directory switch of app installs
 * (Phase 7a, Q23; core nexus/Installer.ts). Node has no renameat2(2).
 *
 *   aura-rename-exchange exchange <a> <b>  swap two paths atomically
 *                                          (RENAME_EXCHANGE), then fsync both
 *                                          parent directories
 *   aura-rename-exchange rename <a> <b>    rename without replacing
 *                                          (RENAME_NOREPLACE), then fsync the
 *                                          parents
 *   aura-rename-exchange sync <path>...    fsync each path (file or dir)
 *   aura-rename-exchange syncfs <path>     syncfs(2) of the filesystem of path
 *   aura-rename-exchange probe <dir>       can <dir>'s filesystem exchange?
 *   aura-rename-exchange version
 *
 * Exit: 0 ok; 3 the filesystem does not support the operation (EINVAL,
 * ENOSYS, EOPNOTSUPP: the caller refuses installs, fail closed); 2 usage;
 * 1 any other error (message on stderr). No fallback to two renames.
 * Static, no dependencies; built in the Dockerfile like os/session-enter.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <libgen.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif
#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE (1 << 1)
#endif

#define VERSION "1"
#define EXIT_UNSUPPORTED 3

static int unsupported(int e) { return e == EINVAL || e == ENOSYS || e == EOPNOTSUPP; }

static int do_renameat2(const char *a, const char *b, unsigned int flags) {
	return (int)syscall(SYS_renameat2, AT_FDCWD, a, AT_FDCWD, b, flags);
}

static int fsync_path(const char *p) {
	int fd = open(p, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
	if (fd < 0 && errno == ELOOP) return 0; /* a symlink: its parent's fsync covers it */
	if (fd < 0) return -1;
	int r = fsync(fd);
	int e = errno;
	close(fd);
	errno = e;
	return r;
}

static int fsync_parent(const char *p) {
	char *copy = strdup(p);
	if (!copy) return -1;
	int r = fsync_path(dirname(copy));
	free(copy);
	return r;
}

static int fail(const char *what, const char *path) {
	int e = errno;
	fprintf(stderr, "aura-rename-exchange: %s %s: %s\n", what, path, strerror(e));
	return unsupported(e) ? EXIT_UNSUPPORTED : 1;
}

static int swap(const char *a, const char *b, unsigned int flags) {
	if (do_renameat2(a, b, flags) != 0) return fail(flags == RENAME_EXCHANGE ? "exchange" : "rename", a);
	if (fsync_parent(a) != 0) return fail("fsync parent of", a);
	if (fsync_parent(b) != 0) return fail("fsync parent of", b);
	return 0;
}

static int probe(const char *dir) {
	char a[4096], b[4096];
	if (snprintf(a, sizeof a, "%s/.aura-xprobe-a.%d", dir, (int)getpid()) >= (int)sizeof a) return 2;
	if (snprintf(b, sizeof b, "%s/.aura-xprobe-b.%d", dir, (int)getpid()) >= (int)sizeof b) return 2;
	rmdir(a);
	rmdir(b);
	if (mkdir(a, 0700) != 0) return fail("mkdir", a);
	if (mkdir(b, 0700) != 0) { int r = fail("mkdir", b); rmdir(a); return r; }
	struct stat sa, sb, after;
	stat(a, &sa);
	stat(b, &sb);
	int r = 0;
	if (do_renameat2(a, b, RENAME_EXCHANGE) != 0) r = fail("exchange", a);
	else if (stat(a, &after) != 0 || after.st_ino != sb.st_ino) { fprintf(stderr, "aura-rename-exchange: exchange did not swap\n"); r = 1; }
	rmdir(a);
	rmdir(b);
	return r;
}

int main(int argc, char **argv) {
	if (argc == 2 && strcmp(argv[1], "version") == 0) { puts(VERSION); return 0; }
	if (argc == 4 && strcmp(argv[1], "exchange") == 0) return swap(argv[2], argv[3], RENAME_EXCHANGE);
	if (argc == 4 && strcmp(argv[1], "rename") == 0) return swap(argv[2], argv[3], RENAME_NOREPLACE);
	if (argc == 3 && strcmp(argv[1], "probe") == 0) return probe(argv[2]);
	if (argc == 3 && strcmp(argv[1], "syncfs") == 0) {
		int fd = open(argv[2], O_RDONLY | O_CLOEXEC);
		if (fd < 0) return fail("open", argv[2]);
		int r = syncfs(fd);
		close(fd);
		return r == 0 ? 0 : fail("syncfs", argv[2]);
	}
	if (argc >= 3 && strcmp(argv[1], "sync") == 0) {
		for (int i = 2; i < argc; i++) if (fsync_path(argv[i]) != 0) return fail("fsync", argv[i]);
		return 0;
	}
	fprintf(stderr, "usage: aura-rename-exchange exchange|rename <a> <b> | sync <path>... | syncfs <path> | probe <dir> | version\n");
	return 2;
}
