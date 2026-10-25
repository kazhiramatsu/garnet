/* The primitives of garnet's Node.js modules (lib/node, docs/node_compat_design.md),
   as the global `__garnet_node`: thin POSIX calls over files, the process, the
   system and clocks. Included at the end of ts_rt.c (one translation unit).
   A failing call answers undefined (or false / -1) and leaves its errno for
   `lastError()`, which the TypeScript side turns into Node's error objects. */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pwd.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/utsname.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <crt_externs.h>
#include <mach-o/dyld.h>
#include <sys/sysctl.h>
#include <mach/mach.h>
#else
#include <sys/sysinfo.h>
#include <sys/random.h>
#endif
extern char** environ;

static int nh_last_errno;
static struct timespec nh_start;
static int nh_argc;
static char** nh_argv;

static tsv nh_arg(tsv* a, int n, int i){ return i < n ? a[i] : TS_UNDEFINED; }
static uint32_t nh_elem_size(uint8_t elem){
  switch (elem){
    case TS_TA_INT16: case TS_TA_UINT16: return 2;
    case TS_TA_INT32: case TS_TA_UINT32: case TS_TA_FLOAT32: return 4;
    case TS_TA_FLOAT64: return 8;
    default: return 1;
  }
}
static tsv nh_string(const char* value){ return ts_new_string(value, (uint32_t)strlen(value)); }
static tsv nh_fail(tsv answer){ nh_last_errno = errno; return answer; }
static char* nh_path_of(tsv value){
  if (!ts_is_str(value)) ts_throw_type_error_msg("The \"path\" argument must be of type string");
  uint32_t length;
  char* result = ts_string_utf8_copy(value, &length);
  if (memchr(result, 0, length)){ free(result); ts_throw_type_error_msg("The argument 'path' must be a string without null bytes"); }
  return result;
}
static double nh_num(tsv* a, int n, int i, double dflt){ tsv v = nh_arg(a, n, i); return ts_is_num(v) ? ts_to_num(v) : dflt; }
/* the bytes of a string (UTF-8, a copy) or a Uint8Array argument */
typedef struct { const uint8_t* data; uint32_t length; char* owned; } nh_bytes;
static nh_bytes nh_bytes_of(tsv v){
  nh_bytes b = { NULL, 0, NULL };
  if (ts_is_typed_array(v)){
    ts_typedarray* t = (ts_typedarray*)ts_ptr(v);
    b.data = t->data; b.length = t->length * (uint32_t)nh_elem_size(t->elem);
    return b;
  }
  if (!ts_is_str(v)) ts_throw_type_error_msg("The \"data\" argument must be of type string or an instance of Uint8Array");
  uint32_t length; b.owned = ts_string_utf8_copy(v, &length);
  b.data = (const uint8_t*)b.owned; b.length = length;
  return b;
}
static tsv nh_pair(double x, double y){
  tsv out = ts_new_array(0); ts_gc_root(&out);
  ts_array_push(out, ts_num(x)); ts_array_push(out, ts_num(y));
  ts_gc_unroot(1);
  return out;
}
/* The program's arguments without main's parameters (the generated main is
   `main(void)`): the loader's copy on macOS, /proc on Linux. */
static void nh_load_argv(void){
#ifdef __APPLE__
  nh_argc = *_NSGetArgc(); nh_argv = *_NSGetArgv();
#else
  FILE* f = fopen("/proc/self/cmdline", "rb");
  if (!f) return;
  size_t cap = 4096, len = 0; char* buf = (char*)malloc(cap);
  for (;;){
    size_t got = fread(buf + len, 1, cap - len, f);
    len += got;
    if (len < cap) break;
    cap *= 2; buf = (char*)realloc(buf, cap);
  }
  fclose(f);
  int count = 0;
  for (size_t i = 0; i < len; i++) if (buf[i] == 0) count++;
  nh_argv = (char**)calloc((size_t)count + 1, sizeof(char*));
  size_t start = 0; int k = 0;
  for (size_t i = 0; i < len; i++) if (buf[i] == 0){ nh_argv[k++] = buf + start; start = i + 1; }
  nh_argc = count;
#endif
}
static tsv nh_read_fd_all(int fd){
  size_t cap = 65536, len = 0;
  uint8_t* buf = (uint8_t*)malloc(cap);
  for (;;){
    if (len == cap){ cap *= 2; buf = (uint8_t*)realloc(buf, cap); }
    ssize_t r = read(fd, buf + len, cap - len);
    if (r < 0){ if (errno == EINTR) continue; nh_last_errno = errno; free(buf); return TS_UNDEFINED; }
    if (r == 0) break;
    len += (size_t)r;
  }
  if (len > UINT32_MAX){ free(buf); nh_last_errno = EFBIG; return TS_UNDEFINED; }
  tsv n = ts_num((double)len);
  tsv out = ts_new_typed_array(TS_TA_UINT8, &n, 1);
  memcpy(((ts_typedarray*)ts_ptr(out))->data, buf, len);
  free(buf);
  return out;
}
/* readFile(path | fd): the whole file as a Uint8Array */
static tsv nh_read_file(tsv* a, int n){
  tsv p = nh_arg(a, n, 0);
  if (ts_is_num(p)) return nh_read_fd_all((int)ts_to_num(p));
  char* path = nh_path_of(p);
  int fd = open(path, O_RDONLY | O_CLOEXEC); free(path);
  if (fd < 0) return nh_fail(TS_UNDEFINED);
  struct stat st;
  if (fstat(fd, &st)){ nh_last_errno = errno; close(fd); return TS_UNDEFINED; }
  if (S_ISDIR(st.st_mode)){ nh_last_errno = EISDIR; close(fd); return TS_UNDEFINED; }
  if (!S_ISREG(st.st_mode)){ tsv out = nh_read_fd_all(fd); close(fd); return out; }
  if ((unsigned long long)st.st_size > UINT32_MAX){ nh_last_errno = EFBIG; close(fd); return TS_UNDEFINED; }
  tsv len = ts_num((double)st.st_size);
  tsv out = ts_new_typed_array(TS_TA_UINT8, &len, 1);
  ts_typedarray* t = (ts_typedarray*)ts_ptr(out);
  size_t got = 0;
  while (got < t->length){
    ssize_t r = read(fd, t->data + got, t->length - got);
    if (r < 0){ if (errno == EINTR) continue; nh_last_errno = errno; close(fd); return TS_UNDEFINED; }
    if (r == 0) break;
    got += (size_t)r;
  }
  close(fd);
  return out;
}
static int nh_write_all(int fd, const uint8_t* data, size_t length){
  size_t done = 0;
  if (fd == 1) fflush(stdout); else if (fd == 2) fflush(stderr);
  while (done < length){
    ssize_t w = write(fd, data + done, length - done);
    if (w < 0){ if (errno == EINTR) continue; nh_last_errno = errno; return -1; }
    done += (size_t)w;
  }
  return 0;
}
/* the flags string of fs.open: "r" "r+" "rs+" "w" "wx" "w+" "wx+" "a" "ax" "a+" "ax+" */
static int nh_open_flags(tsv v, int* out){
  if (!ts_is_str(v)){ *out = O_RDONLY; return 1; }
  uint32_t len; char* s = ts_string_utf8_copy(v, &len);
  int f = -1;
  if (!strcmp(s, "r") || !strcmp(s, "rs")) f = O_RDONLY;
  else if (!strcmp(s, "r+") || !strcmp(s, "rs+")) f = O_RDWR;
  else if (!strcmp(s, "w")) f = O_WRONLY | O_CREAT | O_TRUNC;
  else if (!strcmp(s, "wx") || !strcmp(s, "xw")) f = O_WRONLY | O_CREAT | O_TRUNC | O_EXCL;
  else if (!strcmp(s, "w+")) f = O_RDWR | O_CREAT | O_TRUNC;
  else if (!strcmp(s, "wx+") || !strcmp(s, "xw+")) f = O_RDWR | O_CREAT | O_TRUNC | O_EXCL;
  else if (!strcmp(s, "a")) f = O_WRONLY | O_CREAT | O_APPEND;
  else if (!strcmp(s, "ax") || !strcmp(s, "xa")) f = O_WRONLY | O_CREAT | O_APPEND | O_EXCL;
  else if (!strcmp(s, "a+")) f = O_RDWR | O_CREAT | O_APPEND;
  else if (!strcmp(s, "ax+") || !strcmp(s, "xa+")) f = O_RDWR | O_CREAT | O_APPEND | O_EXCL;
  free(s);
  if (f < 0) return 0;
  *out = f | O_CLOEXEC;
  return 1;
}
/* writeFile(path | fd, data, flags = "w", mode = 0o666) */
static tsv nh_write_file(tsv* a, int n){
  tsv p = nh_arg(a, n, 0);
  nh_bytes b = nh_bytes_of(nh_arg(a, n, 1));
  int fd, opened = 0;
  if (ts_is_num(p)) fd = (int)ts_to_num(p);
  else {
    int flags;
    if (!nh_open_flags(n > 2 ? a[2] : TS_UNDEFINED, &flags)) flags = O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC;
    char* path = nh_path_of(p);
    fd = open(path, flags, (mode_t)nh_num(a, n, 3, 0666)); free(path);
    if (fd < 0){ free(b.owned); return nh_fail(ts_bool(0)); }
    opened = 1;
  }
  int rc = nh_write_all(fd, b.data, b.length);
  free(b.owned);
  if (opened) close(fd);
  return ts_bool(rc == 0);
}
/* open(path, flags, mode) -> fd | -1 */
static tsv nh_open(tsv* a, int n){
  int flags;
  if (!nh_open_flags(nh_arg(a, n, 1), &flags)) ts_throw_type_error_msg("Unknown file open flag");
  char* path = nh_path_of(nh_arg(a, n, 0));
  int fd = open(path, flags, (mode_t)nh_num(a, n, 2, 0666)); free(path);
  if (fd < 0) return nh_fail(ts_num(-1));
  return ts_num((double)fd);
}
static tsv nh_close(tsv* a, int n){ return close((int)nh_num(a, n, 0, -1)) ? nh_fail(ts_bool(0)) : ts_bool(1); }
/* read(fd, buffer, offset, length, position | -1) -> bytes read, -1 on failure */
static tsv nh_read(tsv* a, int n){
  int fd = (int)nh_num(a, n, 0, -1);
  tsv buf = nh_arg(a, n, 1);
  if (!ts_is_typed_array(buf)) ts_throw_type_error_msg("The \"buffer\" argument must be an instance of Uint8Array");
  ts_typedarray* t = (ts_typedarray*)ts_ptr(buf);
  uint32_t bytes = t->length * (uint32_t)nh_elem_size(t->elem);
  double off = nh_num(a, n, 2, 0), len = nh_num(a, n, 3, (double)bytes - off), pos = nh_num(a, n, 4, -1);
  if (!(off >= 0) || !(len >= 0) || off + len > bytes) ts_throw_range_error_msg("The value of \"length\" is out of range");
  ssize_t r;
  do { r = pos >= 0 ? pread(fd, t->data + (size_t)off, (size_t)len, (off_t)pos) : read(fd, t->data + (size_t)off, (size_t)len); } while (r < 0 && errno == EINTR);
  if (r < 0) nh_last_errno = errno;
  return ts_num((double)r);
}
/* write(fd, data, offset, length, position | -1) -> bytes written, -1 on failure */
static tsv nh_write(tsv* a, int n){
  int fd = (int)nh_num(a, n, 0, -1);
  nh_bytes b = nh_bytes_of(nh_arg(a, n, 1));
  double off = nh_num(a, n, 2, 0), len = nh_num(a, n, 3, (double)b.length - off), pos = nh_num(a, n, 4, -1);
  if (!(off >= 0) || !(len >= 0) || off + len > b.length){ free(b.owned); ts_throw_range_error_msg("The value of \"length\" is out of range"); }
  if (fd == 1) fflush(stdout); else if (fd == 2) fflush(stderr);
  ssize_t w;
  do { w = pos >= 0 ? pwrite(fd, b.data + (size_t)off, (size_t)len, (off_t)pos) : write(fd, b.data + (size_t)off, (size_t)len); } while (w < 0 && errno == EINTR);
  if (w < 0) nh_last_errno = errno;
  free(b.owned);
  return ts_num((double)w);
}
static double nh_ts_ms(struct timespec t){ return (double)t.tv_sec * 1e3 + (double)t.tv_nsec / 1e6; }
static tsv nh_stat_array(struct stat* st){
  int kind = S_ISREG(st->st_mode) ? 1 : S_ISDIR(st->st_mode) ? 2 : S_ISLNK(st->st_mode) ? 3 : S_ISFIFO(st->st_mode) ? 4 : S_ISSOCK(st->st_mode) ? 5 : S_ISCHR(st->st_mode) ? 6 : S_ISBLK(st->st_mode) ? 7 : 0;
#ifdef __APPLE__
  double atime = nh_ts_ms(st->st_atimespec), mtime = nh_ts_ms(st->st_mtimespec), ctime = nh_ts_ms(st->st_ctimespec), birth = nh_ts_ms(st->st_birthtimespec);
#else
  double atime = nh_ts_ms(st->st_atim), mtime = nh_ts_ms(st->st_mtim), ctime = nh_ts_ms(st->st_ctim), birth = ctime;
#endif
  double v[14] = { (double)kind, (double)st->st_size, mtime, (double)st->st_mode, (double)st->st_uid, (double)st->st_gid, atime, ctime, birth,
                   (double)st->st_nlink, (double)st->st_dev, (double)st->st_ino, (double)st->st_blksize, (double)st->st_blocks };
  tsv out = ts_new_array(0); ts_gc_root(&out);
  for (int i = 0; i < 14; i++) ts_array_push(out, ts_num(v[i]));
  ts_gc_unroot(1);
  return out;
}
/* stat(path, follow) -> [kind, size, mtimeMs, mode, uid, gid, atimeMs, ctimeMs, birthtimeMs, nlink, dev, ino, blksize, blocks]
   (kind: 1 file, 2 directory, 3 link, 4 fifo, 5 socket, 6 character device, 7 block device, 0 other) */
static tsv nh_stat(tsv* a, int n){
  char* path = nh_path_of(nh_arg(a, n, 0));
  struct stat st;
  int rc = ts_truthy(nh_arg(a, n, 1)) ? stat(path, &st) : lstat(path, &st);
  free(path);
  return rc ? nh_fail(TS_UNDEFINED) : nh_stat_array(&st);
}
static tsv nh_fstat(tsv* a, int n){
  struct stat st;
  return fstat((int)nh_num(a, n, 0, -1), &st) ? nh_fail(TS_UNDEFINED) : nh_stat_array(&st);
}
/* readdir(path) -> [names, kinds] */
static tsv nh_readdir(tsv* a, int n){
  char* path = nh_path_of(nh_arg(a, n, 0));
  DIR* dir = opendir(path);
  if (!dir){ free(path); return nh_fail(TS_UNDEFINED); }
  tsv names = ts_new_array(0); ts_gc_root(&names);
  tsv kinds = ts_new_array(0); ts_gc_root(&kinds);
  struct dirent* e;
  while ((e = readdir(dir))){
    if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
    int kind;
    if (e->d_type == DT_REG) kind = 1;
    else if (e->d_type == DT_DIR) kind = 2;
    else if (e->d_type == DT_LNK) kind = 3;
    else if (e->d_type == DT_FIFO) kind = 4;
    else if (e->d_type == DT_SOCK) kind = 5;
    else if (e->d_type == DT_CHR) kind = 6;
    else if (e->d_type == DT_BLK) kind = 7;
    else {
      size_t size = strlen(path) + strlen(e->d_name) + 2; char* full = (char*)malloc(size);
      snprintf(full, size, "%s/%s", path, e->d_name);
      struct stat st; kind = lstat(full, &st) ? 0 : S_ISREG(st.st_mode) ? 1 : S_ISDIR(st.st_mode) ? 2 : S_ISLNK(st.st_mode) ? 3 : 0;
      free(full);
    }
    tsv name = nh_string(e->d_name);
    ts_array_push(names, name);
    ts_array_push(kinds, ts_num(kind));
  }
  closedir(dir); free(path);
  tsv out = ts_new_array(0); ts_gc_root(&out);
  ts_array_push(out, names); ts_array_push(out, kinds);
  ts_gc_unroot(3);
  return out;
}
static int nh_mkdir_p(char* path, mode_t mode){
  struct stat st;
  if (!stat(path, &st)) return S_ISDIR(st.st_mode) ? 0 : (errno = EEXIST, -1);
  char* slash = strrchr(path, '/');
  if (slash && slash != path){
    *slash = 0; int rc = nh_mkdir_p(path, mode); *slash = '/';
    if (rc) return rc;
  }
  return mkdir(path, mode) && errno != EEXIST ? -1 : 0;
}
/* mkdir(path, recursive, mode) */
static tsv nh_mkdir(tsv* a, int n){
  char* path = nh_path_of(nh_arg(a, n, 0));
  mode_t mode = (mode_t)nh_num(a, n, 2, 0777);
  int rc = ts_truthy(nh_arg(a, n, 1)) ? nh_mkdir_p(path, mode) : mkdir(path, mode);
  free(path);
  return rc ? nh_fail(ts_bool(0)) : ts_bool(1);
}
static tsv nh_rmdir(tsv* a, int n){ char* p = nh_path_of(nh_arg(a, n, 0)); int rc = rmdir(p); free(p); return rc ? nh_fail(ts_bool(0)) : ts_bool(1); }
static tsv nh_unlink(tsv* a, int n){ char* p = nh_path_of(nh_arg(a, n, 0)); int rc = unlink(p); free(p); return rc ? nh_fail(ts_bool(0)) : ts_bool(1); }
static tsv nh_rename(tsv* a, int n){
  char* p = nh_path_of(nh_arg(a, n, 0)); char* q = nh_path_of(nh_arg(a, n, 1));
  int rc = rename(p, q); free(p); free(q);
  return rc ? nh_fail(ts_bool(0)) : ts_bool(1);
}
static tsv nh_link(tsv* a, int n){
  char* p = nh_path_of(nh_arg(a, n, 0)); char* q = nh_path_of(nh_arg(a, n, 1));
  int rc = link(p, q); free(p); free(q);
  return rc ? nh_fail(ts_bool(0)) : ts_bool(1);
}
static tsv nh_symlink(tsv* a, int n){
  char* target = nh_path_of(nh_arg(a, n, 0)); char* p = nh_path_of(nh_arg(a, n, 1));
  int rc = symlink(target, p); free(target); free(p);
  return rc ? nh_fail(ts_bool(0)) : ts_bool(1);
}
static tsv nh_readlink(tsv* a, int n){
  char* p = nh_path_of(nh_arg(a, n, 0)); char out[PATH_MAX];
  ssize_t len = readlink(p, out, sizeof out - 1); free(p);
  if (len < 0) return nh_fail(TS_UNDEFINED);
  return ts_new_string(out, (uint32_t)len);
}
static tsv nh_realpath(tsv* a, int n){
  char* p = nh_path_of(nh_arg(a, n, 0)); char out[PATH_MAX];
  char* r = realpath(p, out); free(p);
  return r ? nh_string(out) : nh_fail(TS_UNDEFINED);
}
static tsv nh_chmod(tsv* a, int n){ char* p = nh_path_of(nh_arg(a, n, 0)); int rc = chmod(p, (mode_t)nh_num(a, n, 1, 0)); free(p); return rc ? nh_fail(ts_bool(0)) : ts_bool(1); }
static tsv nh_utimes(tsv* a, int n){
  char* p = nh_path_of(nh_arg(a, n, 0));
  double at = nh_num(a, n, 1, 0), mt = nh_num(a, n, 2, 0);
  struct timeval tv[2];
  tv[0].tv_sec = (time_t)(at / 1e3); tv[0].tv_usec = (suseconds_t)(fmod(at, 1e3) * 1e3);
  tv[1].tv_sec = (time_t)(mt / 1e3); tv[1].tv_usec = (suseconds_t)(fmod(mt, 1e3) * 1e3);
  int rc = utimes(p, tv); free(p);
  return rc ? nh_fail(ts_bool(0)) : ts_bool(1);
}
/* truncate(path | fd, length) */
static tsv nh_truncate(tsv* a, int n){
  tsv p = nh_arg(a, n, 0); off_t len = (off_t)nh_num(a, n, 1, 0);
  int rc;
  if (ts_is_num(p)) rc = ftruncate((int)ts_to_num(p), len);
  else { char* path = nh_path_of(p); rc = truncate(path, len); free(path); }
  return rc ? nh_fail(ts_bool(0)) : ts_bool(1);
}
static tsv nh_access(tsv* a, int n){ char* p = nh_path_of(nh_arg(a, n, 0)); int rc = access(p, (int)nh_num(a, n, 1, F_OK)); free(p); return rc ? nh_fail(ts_bool(0)) : ts_bool(1); }
/* copyFile(src, dst, exclusive) */
static tsv nh_copy_file(tsv* a, int n){
  char* src = nh_path_of(nh_arg(a, n, 0)); char* dst = nh_path_of(nh_arg(a, n, 1));
  int in = open(src, O_RDONLY | O_CLOEXEC);
  if (in < 0){ nh_last_errno = errno; free(src); free(dst); return ts_bool(0); }
  struct stat st; fstat(in, &st);
  int flags = O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC | (ts_truthy(nh_arg(a, n, 2)) ? O_EXCL : 0);
  int out = open(dst, flags, st.st_mode & 0777);
  if (out < 0){ nh_last_errno = errno; close(in); free(src); free(dst); return ts_bool(0); }
  char buf[65536]; int ok = 1;
  for (;;){
    ssize_t r = read(in, buf, sizeof buf);
    if (r < 0){ if (errno == EINTR) continue; nh_last_errno = errno; ok = 0; break; }
    if (r == 0) break;
    if (nh_write_all(out, (const uint8_t*)buf, (size_t)r)){ ok = 0; break; }
  }
  close(in); close(out); free(src); free(dst);
  return ts_bool(ok);
}
static tsv nh_fsync(tsv* a, int n){ return fsync((int)nh_num(a, n, 0, -1)) ? nh_fail(ts_bool(0)) : ts_bool(1); }
static tsv nh_isatty(tsv* a, int n){ return ts_bool(isatty((int)nh_num(a, n, 0, -1))); }
static tsv nh_tty_size(tsv* a, int n){
  struct winsize w;
  if (ioctl((int)nh_num(a, n, 0, 1), TIOCGWINSZ, &w)) return nh_fail(TS_UNDEFINED);
  return nh_pair((double)w.ws_col, (double)w.ws_row);
}
static const char* nh_errno_name(int e){
  switch (e){
    case ENOENT: return "ENOENT"; case EACCES: return "EACCES"; case EEXIST: return "EEXIST"; case EISDIR: return "EISDIR";
    case ENOTDIR: return "ENOTDIR"; case ENOTEMPTY: return "ENOTEMPTY"; case EPERM: return "EPERM"; case EAGAIN: return "EAGAIN";
    case ELOOP: return "ELOOP"; case EBADF: return "EBADF"; case EINVAL: return "EINVAL"; case EMFILE: return "EMFILE";
    case ENFILE: return "ENFILE"; case ENOSPC: return "ENOSPC"; case EROFS: return "EROFS"; case EXDEV: return "EXDEV";
    case EBUSY: return "EBUSY"; case ENAMETOOLONG: return "ENAMETOOLONG"; case EFBIG: return "EFBIG"; case EPIPE: return "EPIPE";
    case ESRCH: return "ESRCH"; case ECHILD: return "ECHILD"; case EINTR: return "EINTR"; case ENOTSUP: return "ENOTSUP";
    case ESPIPE: return "ESPIPE"; case ENXIO: return "ENXIO"; case EIO: return "EIO"; case ENOMEM: return "ENOMEM";
    case ETXTBSY: return "ETXTBSY"; case EMLINK: return "EMLINK"; case ENOTTY: return "ENOTTY"; case EDQUOT: return "EDQUOT";
    default: return "EIO";
  }
}
static tsv nh_last_error(tsv* a, int n){ (void)a; (void)n; return nh_string(nh_errno_name(nh_last_errno)); }
static tsv nh_last_errno_fn(tsv* a, int n){ (void)a; (void)n; return ts_num((double)-nh_last_errno); }
/* -- the process -- */
static tsv nh_argv_fn(tsv* a, int n){
  (void)a; (void)n;
  tsv out = ts_new_array(0); ts_gc_root(&out);
  for (int i = 0; i < nh_argc; i++){ tsv s = nh_string(nh_argv[i]); ts_array_push(out, s); }
  ts_gc_unroot(1);
  return out;
}
static tsv nh_env(tsv* a, int n){
  (void)a; (void)n;
  tsv env = ts_new_object(); ts_gc_root(&env);
  for (char** e = environ; *e; e++){
    const char* eq = strchr(*e, '=');
    if (!eq || eq == *e) continue;
    char* name = strndup(*e, (size_t)(eq - *e));
    tsv value = nh_string(eq + 1); ts_gc_root(&value);
    ts_set_cstr(env, name, value);
    ts_gc_unroot(1); free(name);
  }
  ts_gc_unroot(1);
  return env;
}
static tsv nh_cwd(tsv* a, int n){ (void)a; (void)n; char out[PATH_MAX]; return getcwd(out, sizeof out) ? nh_string(out) : nh_fail(TS_UNDEFINED); }
static tsv nh_chdir(tsv* a, int n){ char* p = nh_path_of(nh_arg(a, n, 0)); int rc = chdir(p); free(p); return rc ? nh_fail(ts_bool(0)) : ts_bool(1); }
static tsv nh_exec_path(tsv* a, int n){
  (void)a; (void)n;
  char out[PATH_MAX];
#ifdef __APPLE__
  uint32_t size = sizeof out; char raw[PATH_MAX];
  if (_NSGetExecutablePath(raw, &size) == 0 && realpath(raw, out)) return nh_string(out);
#else
  ssize_t len = readlink("/proc/self/exe", out, sizeof out - 1);
  if (len > 0){ out[len] = 0; return nh_string(out); }
#endif
  return nh_string(nh_argc > 0 ? nh_argv[0] : "");
}
static tsv nh_exit(tsv* a, int n){
  int code = (int)nh_num(a, n, 0, 0);
  fflush(stdout); fflush(stderr);
  if (ts_worker_is_worker()) _exit(code);
  exit(code);
}
static tsv nh_pid(tsv* a, int n){ (void)a; (void)n; return ts_num((double)getpid()); }
static tsv nh_ppid(tsv* a, int n){ (void)a; (void)n; return ts_num((double)getppid()); }
static tsv nh_kill(tsv* a, int n){ return kill((pid_t)nh_num(a, n, 0, 0), (int)nh_num(a, n, 1, SIGTERM)) ? nh_fail(ts_bool(0)) : ts_bool(1); }
static tsv nh_umask(tsv* a, int n){
  tsv v = nh_arg(a, n, 0);
  mode_t old;
  if (ts_is_num(v)) old = umask((mode_t)ts_to_num(v));
  else { old = umask(0); umask(old); }
  return ts_num((double)old);
}
static tsv nh_hrtime(tsv* a, int n){
  (void)a; (void)n;
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return nh_pair((double)t.tv_sec, (double)t.tv_nsec);
}
static tsv nh_now(tsv* a, int n){
  (void)a; (void)n;
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return ts_num((double)(t.tv_sec - nh_start.tv_sec) * 1e3 + (double)(t.tv_nsec - nh_start.tv_nsec) / 1e6);
}
static tsv nh_time_origin(tsv* a, int n){
  (void)a; (void)n;
  struct timespec w; clock_gettime(CLOCK_REALTIME, &w);
  struct timespec m; clock_gettime(CLOCK_MONOTONIC, &m);
  double since_start = (double)(m.tv_sec - nh_start.tv_sec) * 1e3 + (double)(m.tv_nsec - nh_start.tv_nsec) / 1e6;
  return ts_num(nh_ts_ms(w) - since_start);
}
static tsv nh_rss(tsv* a, int n){
  (void)a; (void)n;
#ifdef __APPLE__
  struct mach_task_basic_info info; mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
  if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO, (task_info_t)&info, &count) == KERN_SUCCESS) return ts_num((double)info.resident_size);
  struct rusage r; getrusage(RUSAGE_SELF, &r); return ts_num((double)r.ru_maxrss);
#else
  FILE* f = fopen("/proc/self/statm", "r"); long pages = 0, resident = 0;
  if (f){ if (fscanf(f, "%ld %ld", &pages, &resident) != 2) resident = 0; fclose(f); }
  return ts_num((double)resident * (double)sysconf(_SC_PAGESIZE));
#endif
}
static tsv nh_cpu_usage(tsv* a, int n){
  (void)a; (void)n;
  struct rusage r; getrusage(RUSAGE_SELF, &r);
  return nh_pair((double)r.ru_utime.tv_sec * 1e6 + (double)r.ru_utime.tv_usec, (double)r.ru_stime.tv_sec * 1e6 + (double)r.ru_stime.tv_usec);
}
/* -- the system -- */
static tsv nh_hostname(tsv* a, int n){ (void)a; (void)n; char out[256]; if (gethostname(out, sizeof out)) return nh_fail(nh_string("localhost")); out[sizeof out - 1] = 0; return nh_string(out); }
static tsv nh_homedir(tsv* a, int n){
  (void)a; (void)n;
  const char* h = getenv("HOME");
  if (h && h[0]) return nh_string(h);
  struct passwd* pw = getpwuid(getuid());
  return nh_string(pw && pw->pw_dir ? pw->pw_dir : "/");
}
static tsv nh_tmpdir(tsv* a, int n){
  (void)a; (void)n;
  const char* names[3] = { "TMPDIR", "TMP", "TEMP" };
  const char* t = NULL;
  for (int i = 0; i < 3 && !t; i++){ const char* v = getenv(names[i]); if (v && v[0]) t = v; }
  if (!t) t = "/tmp";
  size_t len = strlen(t);
  while (len > 1 && t[len - 1] == '/') len--;   /* Node strips one trailing slash; a root "/" stays */
  return ts_new_string(t, (uint32_t)len);
}
static tsv nh_cpus(tsv* a, int n){
  (void)a; (void)n;
  const char* e = getenv("TSAOT_CPUS");
  long c = e && e[0] ? strtol(e, NULL, 10) : sysconf(_SC_NPROCESSORS_ONLN);
  return ts_num(c > 0 ? (double)c : 1);
}
static tsv nh_totalmem(tsv* a, int n){
  (void)a; (void)n;
#ifdef __APPLE__
  uint64_t mem = 0; size_t size = sizeof mem;
  if (sysctlbyname("hw.memsize", &mem, &size, NULL, 0) == 0) return ts_num((double)mem);
  return ts_num(0);
#else
  return ts_num((double)sysconf(_SC_PHYS_PAGES) * (double)sysconf(_SC_PAGE_SIZE));
#endif
}
static tsv nh_freemem(tsv* a, int n){
  (void)a; (void)n;
#ifdef __APPLE__
  vm_statistics64_data_t vm; mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
  if (host_statistics64(mach_host_self(), HOST_VM_INFO64, (host_info64_t)&vm, &count) == KERN_SUCCESS)
    return ts_num((double)vm.free_count * (double)sysconf(_SC_PAGESIZE));
  return ts_num(0);
#else
  struct sysinfo si; if (sysinfo(&si)) return ts_num(0);
  return ts_num((double)si.freeram * (double)si.mem_unit);
#endif
}
static tsv nh_loadavg(tsv* a, int n){
  (void)a; (void)n;
  double l[3] = { 0, 0, 0 }; getloadavg(l, 3);
  tsv out = ts_new_array(0); ts_gc_root(&out);
  for (int i = 0; i < 3; i++) ts_array_push(out, ts_num(l[i]));
  ts_gc_unroot(1);
  return out;
}
static tsv nh_uptime(tsv* a, int n){
  (void)a; (void)n;
#ifdef __APPLE__
  struct timeval boot; size_t size = sizeof boot; int mib[2] = { CTL_KERN, KERN_BOOTTIME };
  if (sysctl(mib, 2, &boot, &size, NULL, 0) == 0){ struct timeval now; gettimeofday(&now, NULL); return ts_num((double)(now.tv_sec - boot.tv_sec)); }
  return ts_num(0);
#else
  struct sysinfo si; if (sysinfo(&si)) return ts_num(0);
  return ts_num((double)si.uptime);
#endif
}
/* uname() -> [sysname, release, version, machine] */
static tsv nh_uname(tsv* a, int n){
  (void)a; (void)n;
  struct utsname u; if (uname(&u)) return nh_fail(TS_UNDEFINED);
  tsv out = ts_new_array(0); ts_gc_root(&out);
  tsv s;
  s = nh_string(u.sysname); ts_array_push(out, s);
  s = nh_string(u.release); ts_array_push(out, s);
  s = nh_string(u.version); ts_array_push(out, s);
  s = nh_string(u.machine); ts_array_push(out, s);
  ts_gc_unroot(1);
  return out;
}
/* userInfo() -> [username, uid, gid, shell, homedir] */
static tsv nh_user_info(tsv* a, int n){
  (void)a; (void)n;
  struct passwd* pw = getpwuid(getuid());
  tsv out = ts_new_array(0); ts_gc_root(&out);
  tsv s;
  s = nh_string(pw && pw->pw_name ? pw->pw_name : ""); ts_array_push(out, s);
  ts_array_push(out, ts_num((double)getuid()));
  ts_array_push(out, ts_num((double)getgid()));
  s = nh_string(pw && pw->pw_shell ? pw->pw_shell : ""); ts_array_push(out, s);
  s = nh_string(pw && pw->pw_dir ? pw->pw_dir : ""); ts_array_push(out, s);
  ts_gc_unroot(1);
  return out;
}
/* -- bytes and values -- */
static tsv nh_utf8_length(tsv* a, int n){
  tsv s = nh_arg(a, n, 0);
  if (!ts_is_str(s)) return ts_num(0);
  uint32_t length; char* bytes = ts_string_utf8_copy(s, &length); free(bytes);
  return ts_num((double)length);
}
static tsv nh_random_bytes(tsv* a, int n){
  double count = nh_num(a, n, 0, 0);
  if (!(count >= 0) || count > 2147483647.0) ts_throw_range_error_msg("The value of \"size\" is out of range");
  tsv len = ts_num(count);
  tsv out = ts_new_typed_array(TS_TA_UINT8, &len, 1);
  ts_typedarray* t = (ts_typedarray*)ts_ptr(out);
#ifdef __APPLE__
  arc4random_buf(t->data, t->length);
#else
  size_t got = 0;
  while (got < t->length){ ssize_t r = getrandom(t->data + got, t->length - got, 0); if (r < 0){ if (errno == EINTR) continue; break; } got += (size_t)r; }
#endif
  return out;
}
/* inspect(value) -> the string console.log prints for the value (util.inspect) */
static tsv nh_inspect(tsv* a, int n){
  tsv v = nh_arg(a, n, 0);
  ts_gc_root(&v);
  char* buf = NULL; size_t len = 0;
  FILE* f = open_memstream(&buf, &len);
  if (!f){ ts_gc_unroot(1); ts_throw_type_error_msg("inspect: out of memory"); }
  int color = g_inspect_color; g_inspect_color = 0;
  ts_print_to(f, v);
  g_inspect_color = color;
  fclose(f);
  tsv out = ts_new_string(buf ? buf : "", (uint32_t)len);
  free(buf);
  ts_gc_unroot(1);
  return out;
}
/* atExit(hook): called once when the event loop ends (the program's natural end);
   a nonzero number it returns is the exit status (process.exitCode). */
static tsv nh_exit_hook = TS_UNDEFINED;
static tsv nh_at_exit(tsv* a, int n){
  static int rooted = 0;
  nh_exit_hook = nh_arg(a, n, 0);
  ts_root_static_once(&nh_exit_hook, &rooted);
  return TS_UNDEFINED;
}
static void nh_run_exit_hook(void){
  if (!ts_is_func(nh_exit_hook)) return;
  tsv hook = nh_exit_hook;
  nh_exit_hook = TS_UNDEFINED;
  tsv r = ts_call_value(hook, NULL, 0);
  drain_microtasks();
  if (ts_is_num(r) && (int)ts_to_num(r) != 0){ fflush(stdout); fflush(stderr); exit((int)ts_to_num(r)); }
}
static void nh_method(tsv host, const char* name, ts_code code, int arity){
  ts_gc_root(&host); tsv fn = ts_make_fn_t(code, NULL, 0, 0); ts_gc_root(&fn);
  ts_set_fn_meta(fn, (uint32_t)arity, name); ts_set_cstr(host, name, fn); ts_gc_unroot(2);
}
static void ts_garnet_node_global_init(tsv global){
  ts_gc_root(&global);
  clock_gettime(CLOCK_MONOTONIC, &nh_start);
  nh_load_argv();
  tsv host = ts_new_object(); ts_gc_root(&host);
  nh_method(host, "readFile", nh_read_file, 1);
  nh_method(host, "writeFile", nh_write_file, 4);
  nh_method(host, "open", nh_open, 3);
  nh_method(host, "close", nh_close, 1);
  nh_method(host, "read", nh_read, 5);
  nh_method(host, "write", nh_write, 5);
  nh_method(host, "stat", nh_stat, 2);
  nh_method(host, "fstat", nh_fstat, 1);
  nh_method(host, "readdir", nh_readdir, 1);
  nh_method(host, "mkdir", nh_mkdir, 3);
  nh_method(host, "rmdir", nh_rmdir, 1);
  nh_method(host, "unlink", nh_unlink, 1);
  nh_method(host, "rename", nh_rename, 2);
  nh_method(host, "link", nh_link, 2);
  nh_method(host, "symlink", nh_symlink, 2);
  nh_method(host, "readlink", nh_readlink, 1);
  nh_method(host, "realpath", nh_realpath, 1);
  nh_method(host, "chmod", nh_chmod, 2);
  nh_method(host, "utimes", nh_utimes, 3);
  nh_method(host, "truncate", nh_truncate, 2);
  nh_method(host, "access", nh_access, 2);
  nh_method(host, "copyFile", nh_copy_file, 3);
  nh_method(host, "fsync", nh_fsync, 1);
  nh_method(host, "isatty", nh_isatty, 1);
  nh_method(host, "ttySize", nh_tty_size, 1);
  nh_method(host, "lastError", nh_last_error, 0);
  nh_method(host, "lastErrno", nh_last_errno_fn, 0);
  nh_method(host, "argv", nh_argv_fn, 0);
  nh_method(host, "env", nh_env, 0);
  nh_method(host, "cwd", nh_cwd, 0);
  nh_method(host, "chdir", nh_chdir, 1);
  nh_method(host, "execPath", nh_exec_path, 0);
  nh_method(host, "exit", nh_exit, 1);
  nh_method(host, "pid", nh_pid, 0);
  nh_method(host, "ppid", nh_ppid, 0);
  nh_method(host, "kill", nh_kill, 2);
  nh_method(host, "umask", nh_umask, 1);
  nh_method(host, "hrtime", nh_hrtime, 0);
  nh_method(host, "now", nh_now, 0);
  nh_method(host, "timeOrigin", nh_time_origin, 0);
  nh_method(host, "rss", nh_rss, 0);
  nh_method(host, "cpuUsage", nh_cpu_usage, 0);
  nh_method(host, "hostname", nh_hostname, 0);
  nh_method(host, "homedir", nh_homedir, 0);
  nh_method(host, "tmpdir", nh_tmpdir, 0);
  nh_method(host, "cpus", nh_cpus, 0);
  nh_method(host, "totalmem", nh_totalmem, 0);
  nh_method(host, "freemem", nh_freemem, 0);
  nh_method(host, "loadavg", nh_loadavg, 0);
  nh_method(host, "uptime", nh_uptime, 0);
  nh_method(host, "uname", nh_uname, 0);
  nh_method(host, "userInfo", nh_user_info, 0);
  nh_method(host, "utf8Length", nh_utf8_length, 1);
  nh_method(host, "randomBytes", nh_random_bytes, 1);
  nh_method(host, "inspect", nh_inspect, 1);
  nh_method(host, "atExit", nh_at_exit, 1);
#ifdef __APPLE__
  ts_set_cstr(host, "platform", nh_string("darwin"));
#else
  ts_set_cstr(host, "platform", nh_string("linux"));
#endif
#if defined(__aarch64__) || defined(__arm64__)
  ts_set_cstr(host, "arch", nh_string("arm64"));
#elif defined(__x86_64__)
  ts_set_cstr(host, "arch", nh_string("x64"));
#else
  ts_set_cstr(host, "arch", nh_string("unknown"));
#endif
  ts_set_cstr(global, "__garnet_node", host);
  ts_gc_unroot(2);
}
