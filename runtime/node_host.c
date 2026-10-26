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
#include <poll.h>
#include <sys/wait.h>
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
  if (fd == 1 || fd == 2){ fflush(stdout); fflush(stderr); }   /* console output before this write, in order, on both streams */
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
  if (fd == 1 || fd == 2){ fflush(stdout); fflush(stderr); }   /* console output before this write, in order, on both streams */
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
/* utf8Length(s): the UTF-8 byte length without a copy; an ASCII or 8-bit string is
   measured by arithmetic, a UTF-16 one by a walk, and a heap string remembers the
   answer in its cell (as the tsc-ts shims' host did: Buffer.byteLength is on the
   compiler's hot path). */
static tsv nh_utf8_length_walk(ts_strview v){
  if (v.data && !(v.flags & TS_STR_FLAG_UTF16)){
    const unsigned char* b = (const unsigned char*)v.data;
    uint64_t high = 0; uint32_t i = 0;
    for (; i + 8u <= v.len; i += 8u){ uint64_t w; memcpy(&w, b + i, 8); high += (uint64_t)__builtin_popcountll(w & 0x8080808080808080ull); }
    for (; i < v.len; i++) high += b[i] >> 7;
    return ts_num((double)v.len + (double)high);
  }
  double total = 0;
  if (v.data){
    /* UTF-16 storage: the units read directly (a source text with one
       character past U+00FF is stored this way and measured once per text) */
    const unsigned char* d = (const unsigned char*)v.data;
    for (uint32_t i = 0; i < v.len; i++){
      uint32_t cu = (uint32_t)d[2 * i] | ((uint32_t)d[2 * i + 1] << 8);
      if (cu < 0x80u) total += 1;
      else if (cu < 0x800u) total += 2;
      else if (cu >= 0xD800u && cu <= 0xDBFFu && i + 1 < v.len){
        uint32_t lo = (uint32_t)d[2 * i + 2] | ((uint32_t)d[2 * i + 3] << 8);
        if (lo >= 0xDC00u && lo <= 0xDFFFu){ total += 4; i++; } else total += 3;
      } else total += 3;
    }
    return ts_num(total);
  }
  for (uint32_t i = 0; i < v.len; i++){
    uint32_t cu = ts_str_cu_at_view(v, i);
    if (cu < 0x80u) total += 1;
    else if (cu < 0x800u) total += 2;
    else if (cu >= 0xD800u && cu <= 0xDBFFu && i + 1 < v.len){
      uint32_t lo = ts_str_cu_at_view(v, i + 1);
      if (lo >= 0xDC00u && lo <= 0xDFFFu){ total += 4; i++; } else total += 3;
    } else total += 3;
  }
  return ts_num(total);
}
static tsv nh_utf8_length(tsv* a, int n){
  tsv s = nh_arg(a, n, 0);
  if (!ts_is_str(s)) return ts_num(0);
  ts_strview v = ts_str_view_typed(s);
  /* ASCII: one byte per unit; 8-bit storage: two bytes for each unit past
     0x7F; UTF-16 storage: the general walk, its answer cached in the flat
     cell's unused view offset (a source text is measured a few times) */
  if (v.flags & TS_STR_FLAG_ASCII) return ts_num((double)v.len);
  ts_string* cell = ts_is_short_str(s) ? NULL : ts_str_ptr_typed(s);
  if (cell && (cell->flags & TS_STR_FLAG_VIEW)) cell = NULL;
  if (cell && (cell->flags & TS_STR_FLAG_UTF8LEN)) return ts_num((double)cell->offset);
  tsv total_v = nh_utf8_length_walk(v);
  if (cell && ts_to_num(total_v) <= 4294967295.0){ cell->offset = (uint32_t)ts_to_num(total_v); cell->flags |= TS_STR_FLAG_UTF8LEN; }
  return total_v;
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
/* phase 0: 'beforeExit' (the hook may schedule more work; the loop then goes on);
   phase 1: 'exit' (the hook's number is the status; the hook runs once) */
static int nh_run_exit_hook_phase(int phase){
  if (!ts_is_func(nh_exit_hook)) return 0;
  tsv hook = nh_exit_hook;
  if (phase == 1) nh_exit_hook = TS_UNDEFINED;
  tsv arg = ts_num((double)phase);
  tsv r = ts_call_value(hook, &arg, 1);
  nh_drain_ticks_and_microtasks();
  if (phase == 1 && ts_is_num(r) && (int)ts_to_num(r) != 0){ fflush(stdout); fflush(stderr); exit((int)ts_to_num(r)); }
  return 1;
}
static void nh_run_exit_hook(void){ nh_run_exit_hook_phase(1); }
/* ---- the event loop's queues (docs/node_compat_design.md): timers, immediates,
   nextTick. A timer is a malloc'd record in a list sorted by due time then by
   id; its callback and arguments are roots (nh_mark_loop_roots). A referenced
   active timer keeps the loop alive; an unreferenced one does not. ---- */
typedef struct nh_timer {
  uint32_t id;
  double due_ms, repeat_ms;   /* repeat_ms 0: once */
  tsv cb, args;               /* args: an array or undefined */
  int refed, active;
  struct nh_timer* next;
} nh_timer;
static nh_timer* g_nh_timers = NULL;
static uint32_t g_nh_next_id = 1;
static int g_nh_refed_timers = 0;
typedef struct nh_immediate { uint32_t id; tsv cb, args; int refed, active; struct nh_immediate* next; } nh_immediate;
static nh_immediate* g_nh_imm_head = NULL;
static nh_immediate* g_nh_imm_tail = NULL;
static int g_nh_refed_immediates = 0;
typedef struct nh_tick { tsv cb, args; struct nh_tick* next; } nh_tick;
static nh_tick* g_nh_tick_head = NULL;
static nh_tick* g_nh_tick_tail = NULL;

static double nh_mono_ms(void){
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec * 1e3 + (double)t.tv_nsec / 1e6;
}
static void nh_timer_insert(nh_timer* t){
  nh_timer** pp = &g_nh_timers;
  while (*pp && ((*pp)->due_ms < t->due_ms || ((*pp)->due_ms == t->due_ms && (*pp)->id < t->id))) pp = &(*pp)->next;
  t->next = *pp; *pp = t;
}
static nh_timer* nh_timer_find(uint32_t id){ for (nh_timer* t = g_nh_timers; t; t = t->next) if (t->id == id) return t; return NULL; }
static void nh_timer_free(nh_timer* t){
  nh_timer** pp = &g_nh_timers;
  while (*pp && *pp != t) pp = &(*pp)->next;
  if (*pp) *pp = t->next;
  if (t->active && t->refed) g_nh_refed_timers--;
  free(t);
}
/* the callback with the arguments array's elements (a stack array up to eight) */
static void nh_call_with_args(tsv cb, tsv args){
  tsv stack_args[8]; tsv* argv = stack_args; uint32_t n = 0;
  ts_gc_root(&cb); ts_gc_root(&args);
  if (ts_is_array(args)){
    n = ts_array_len(args);
    if (n > 8) argv = (tsv*)malloc(sizeof(tsv) * n);
    for (uint32_t i = 0; i < n; i++) argv[i] = ts_array_get(args, i);
  }
  (void)ts_call_value(cb, argv, (int)n);
  if (argv != stack_args) free(argv);
  ts_gc_unroot(2);
}
/* nextTick callbacks run before the microtasks, and a callback's own ticks before
   the microtasks it queued, until both queues are empty (Node's order). */
static void nh_drain_ticks_and_microtasks(void){
  for (;;){
    while (g_nh_tick_head){
      nh_tick* t = g_nh_tick_head;
      g_nh_tick_head = t->next;
      if (!g_nh_tick_head) g_nh_tick_tail = NULL;
      tsv cb = t->cb, args = t->args;
      free(t);
      nh_call_with_args(cb, args);
    }
    drain_microtasks();
    if (!g_nh_tick_head && !g_mq_len) return;
  }
}
static void nh_timers_run_due(void){
  if (!g_nh_timers) return;
  double now = nh_mono_ms();
  for (;;){
    nh_timer* t = g_nh_timers;
    if (!t || t->due_ms > now) break;
    /* unlink before the callback, which may clear or refresh timers (this one
       included: a repeating timer is back in the list, a one-shot is gone), so
       the record is never touched after the call */
    g_nh_timers = t->next; t->next = NULL;
    tsv cb = t->cb, args = t->args;
    if (t->repeat_ms > 0){ t->due_ms = now + t->repeat_ms; nh_timer_insert(t); }
    else { if (t->active && t->refed) g_nh_refed_timers--; free(t); }
    nh_call_with_args(cb, args);
    nh_drain_ticks_and_microtasks();
    unhandled_report();
  }
}
static void nh_immediates_run(void){
  /* the immediates queued before this phase; ones queued by them run next turn */
  nh_immediate* list = g_nh_imm_head;
  g_nh_imm_head = g_nh_imm_tail = NULL;
  while (list){
    nh_immediate* im = list; list = im->next;
    if (im->active){
      if (im->refed) g_nh_refed_immediates--;
      im->active = 0;
      tsv cb = im->cb, args = im->args;
      free(im);
      nh_call_with_args(cb, args);
      nh_drain_ticks_and_microtasks();
      unhandled_report();
    } else free(im);
  }
}
static int nh_io_alive(void);
static void nh_mark_io_roots(int young);
static int nh_loop_alive(void){ return g_nh_refed_timers > 0 || g_nh_refed_immediates > 0 || g_nh_tick_head != NULL || nh_io_alive(); }
static int nh_immediates_pending(void){ return g_nh_imm_head != NULL; }
/* milliseconds until the earliest referenced timer, at most `limit` */
static int nh_next_timer_timeout_ms(int limit){
  double now = nh_mono_ms();
  for (nh_timer* t = g_nh_timers; t; t = t->next){
    if (!t->active) continue;
    double remain = t->due_ms - now;
    if (remain < 0) remain = 0;
    return remain > (double)limit ? limit : (int)(remain + 0.999);
  }
  return limit;
}
static void nh_sleep_ms(int ms){ if (ms > 0) poll(NULL, 0, ms); }
static void nh_mark_loop_roots(int young){
  nh_mark_io_roots(young);
  for (nh_timer* t = g_nh_timers; t; t = t->next){ gc_visit_slot(&t->cb, young, 0, 1); gc_visit_slot(&t->args, young, 0, 1); }
  for (nh_immediate* im = g_nh_imm_head; im; im = im->next){ gc_visit_slot(&im->cb, young, 0, 1); gc_visit_slot(&im->args, young, 0, 1); }
  for (nh_tick* t = g_nh_tick_head; t; t = t->next){ gc_visit_slot(&t->cb, young, 0, 1); gc_visit_slot(&t->args, young, 0, 1); }
}
/* timerAdd(cb, args, delayMs, repeatMs) -> id */
static tsv nh_timer_add(tsv* a, int n){
  tsv cb = nh_arg(a, n, 0);
  if (!ts_is_func(cb)) ts_throw_type_error_msg("The \"callback\" argument must be of type function");
  nh_timer* t = (nh_timer*)calloc(1, sizeof *t);
  if (!t) ts_abort_msg("out of memory creating a timer");
  double delay = nh_num(a, n, 2, 1), repeat = nh_num(a, n, 3, 0);
  t->id = g_nh_next_id++;
  t->due_ms = nh_mono_ms() + delay;
  t->repeat_ms = repeat > 0 ? repeat : 0;
  t->cb = cb; t->args = nh_arg(a, n, 1);
  t->refed = 1; t->active = 1;
  g_nh_refed_timers++;
  nh_timer_insert(t);
  return ts_num((double)t->id);
}
static tsv nh_timer_clear(tsv* a, int n){
  nh_timer* t = nh_timer_find((uint32_t)nh_num(a, n, 0, 0));
  if (t) nh_timer_free(t);
  return TS_UNDEFINED;
}
/* timerRef(id, on) -> whether the timer exists */
static tsv nh_timer_ref(tsv* a, int n){
  nh_timer* t = nh_timer_find((uint32_t)nh_num(a, n, 0, 0));
  if (!t) return ts_bool(0);
  int on = ts_truthy(nh_arg(a, n, 1)) ? 1 : 0;
  if (t->active && on != t->refed) g_nh_refed_timers += on ? 1 : -1;
  t->refed = on;
  return ts_bool(1);
}
static tsv nh_timer_has_ref(tsv* a, int n){ nh_timer* t = nh_timer_find((uint32_t)nh_num(a, n, 0, 0)); return ts_bool(t && t->active && t->refed); }
/* timerRefresh(id, delayMs): the timer runs delayMs from now again */
static tsv nh_timer_refresh(tsv* a, int n){
  nh_timer* t = nh_timer_find((uint32_t)nh_num(a, n, 0, 0));
  if (!t) return ts_bool(0);
  nh_timer** pp = &g_nh_timers;
  while (*pp && *pp != t) pp = &(*pp)->next;
  if (*pp) *pp = t->next;
  t->due_ms = nh_mono_ms() + nh_num(a, n, 1, 1);
  if (!t->active){ t->active = 1; if (t->refed) g_nh_refed_timers++; }
  nh_timer_insert(t);
  return ts_bool(1);
}
static tsv nh_immediate_add(tsv* a, int n){
  tsv cb = nh_arg(a, n, 0);
  if (!ts_is_func(cb)) ts_throw_type_error_msg("The \"callback\" argument must be of type function");
  nh_immediate* im = (nh_immediate*)calloc(1, sizeof *im);
  if (!im) ts_abort_msg("out of memory creating an immediate");
  im->id = g_nh_next_id++; im->cb = cb; im->args = nh_arg(a, n, 1); im->refed = 1; im->active = 1;
  g_nh_refed_immediates++;
  if (g_nh_imm_tail) g_nh_imm_tail->next = im; else g_nh_imm_head = im;
  g_nh_imm_tail = im;
  return ts_num((double)im->id);
}
static nh_immediate* nh_immediate_find(uint32_t id){ for (nh_immediate* im = g_nh_imm_head; im; im = im->next) if (im->id == id && im->active) return im; return NULL; }
static tsv nh_immediate_clear(tsv* a, int n){
  nh_immediate* im = nh_immediate_find((uint32_t)nh_num(a, n, 0, 0));
  if (im){ if (im->refed) g_nh_refed_immediates--; im->active = 0; im->cb = TS_UNDEFINED; im->args = TS_UNDEFINED; }
  return TS_UNDEFINED;
}
static tsv nh_immediate_ref(tsv* a, int n){
  nh_immediate* im = nh_immediate_find((uint32_t)nh_num(a, n, 0, 0));
  if (!im) return ts_bool(0);
  int on = ts_truthy(nh_arg(a, n, 1)) ? 1 : 0;
  if (on != im->refed) g_nh_refed_immediates += on ? 1 : -1;
  im->refed = on;
  return ts_bool(1);
}
static tsv nh_immediate_has_ref(tsv* a, int n){ nh_immediate* im = nh_immediate_find((uint32_t)nh_num(a, n, 0, 0)); return ts_bool(im && im->refed); }
static tsv nh_next_tick(tsv* a, int n){
  tsv cb = nh_arg(a, n, 0);
  if (!ts_is_func(cb)) ts_throw_type_error_msg("The \"callback\" argument must be of type function");
  nh_tick* t = (nh_tick*)calloc(1, sizeof *t);
  if (!t) ts_abort_msg("out of memory queueing a tick");
  t->cb = cb; t->args = nh_arg(a, n, 1);
  if (g_nh_tick_tail) g_nh_tick_tail->next = t; else g_nh_tick_head = t;
  g_nh_tick_tail = t;
  return TS_UNDEFINED;
}
/* ---- digests for node:crypto: md5, sha1, sha256, sha512 (RFC 1321, 3174, 6234) ---- */
static uint32_t nh_rol32(uint32_t x, int n){ return (x << n) | (x >> (32 - n)); }
static uint32_t nh_ror32(uint32_t x, int n){ return (x >> n) | (x << (32 - n)); }
static uint64_t nh_ror64(uint64_t x, int n){ return (x >> n) | (x << (64 - n)); }
static void nh_md5(const uint8_t* msg, size_t len, uint8_t out[16]){
  static const uint32_t K[64] = {
    0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,
    0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,
    0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
    0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391 };
  static const int R[64] = { 7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22, 5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20, 4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23, 6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21 };
  uint32_t h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476;
  size_t total = ((len + 8) / 64 + 1) * 64;
  uint8_t* buf = (uint8_t*)calloc(total, 1);
  memcpy(buf, msg, len); buf[len] = 0x80;
  uint64_t bits = (uint64_t)len * 8;
  for (int i = 0; i < 8; i++) buf[total - 8 + i] = (uint8_t)(bits >> (8 * i));
  for (size_t off = 0; off < total; off += 64){
    uint32_t M[16];
    for (int i = 0; i < 16; i++) M[i] = (uint32_t)buf[off + 4*i] | ((uint32_t)buf[off + 4*i + 1] << 8) | ((uint32_t)buf[off + 4*i + 2] << 16) | ((uint32_t)buf[off + 4*i + 3] << 24);
    uint32_t a = h0, b = h1, c = h2, d = h3;
    for (int i = 0; i < 64; i++){
      uint32_t f; int g;
      if (i < 16){ f = (b & c) | (~b & d); g = i; }
      else if (i < 32){ f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48){ f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      uint32_t tmp = d; d = c; c = b;
      b = b + nh_rol32(a + f + K[i] + M[g], R[i]);
      a = tmp;
    }
    h0 += a; h1 += b; h2 += c; h3 += d;
  }
  free(buf);
  uint32_t hs[4] = { h0, h1, h2, h3 };
  for (int i = 0; i < 4; i++) for (int j = 0; j < 4; j++) out[4*i + j] = (uint8_t)(hs[i] >> (8 * j));
}
static void nh_sha1(const uint8_t* msg, size_t len, uint8_t out[20]){
  uint32_t h[5] = { 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0 };
  size_t total = ((len + 8) / 64 + 1) * 64;
  uint8_t* buf = (uint8_t*)calloc(total, 1);
  memcpy(buf, msg, len); buf[len] = 0x80;
  uint64_t bits = (uint64_t)len * 8;
  for (int i = 0; i < 8; i++) buf[total - 1 - i] = (uint8_t)(bits >> (8 * i));
  for (size_t off = 0; off < total; off += 64){
    uint32_t w[80];
    for (int i = 0; i < 16; i++) w[i] = ((uint32_t)buf[off + 4*i] << 24) | ((uint32_t)buf[off + 4*i + 1] << 16) | ((uint32_t)buf[off + 4*i + 2] << 8) | (uint32_t)buf[off + 4*i + 3];
    for (int i = 16; i < 80; i++) w[i] = nh_rol32(w[i-3] ^ w[i-8] ^ w[i-14] ^ w[i-16], 1);
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for (int i = 0; i < 80; i++){
      uint32_t f, k;
      if (i < 20){ f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (i < 40){ f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60){ f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      uint32_t tmp = nh_rol32(a, 5) + f + e + k + w[i];
      e = d; d = c; c = nh_rol32(b, 30); b = a; a = tmp;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
  }
  free(buf);
  for (int i = 0; i < 5; i++){ out[4*i] = (uint8_t)(h[i] >> 24); out[4*i+1] = (uint8_t)(h[i] >> 16); out[4*i+2] = (uint8_t)(h[i] >> 8); out[4*i+3] = (uint8_t)h[i]; }
}
static void nh_sha256(const uint8_t* msg, size_t len, uint8_t out[32]){
  static const uint32_t K[64] = {
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2 };
  uint32_t h[8] = { 0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19 };
  size_t total = ((len + 8) / 64 + 1) * 64;
  uint8_t* buf = (uint8_t*)calloc(total, 1);
  memcpy(buf, msg, len); buf[len] = 0x80;
  uint64_t bits = (uint64_t)len * 8;
  for (int i = 0; i < 8; i++) buf[total - 1 - i] = (uint8_t)(bits >> (8 * i));
  for (size_t off = 0; off < total; off += 64){
    uint32_t w[64];
    for (int i = 0; i < 16; i++) w[i] = ((uint32_t)buf[off + 4*i] << 24) | ((uint32_t)buf[off + 4*i + 1] << 16) | ((uint32_t)buf[off + 4*i + 2] << 8) | (uint32_t)buf[off + 4*i + 3];
    for (int i = 16; i < 64; i++){
      uint32_t s0 = nh_ror32(w[i-15], 7) ^ nh_ror32(w[i-15], 18) ^ (w[i-15] >> 3);
      uint32_t s1 = nh_ror32(w[i-2], 17) ^ nh_ror32(w[i-2], 19) ^ (w[i-2] >> 10);
      w[i] = w[i-16] + s0 + w[i-7] + s1;
    }
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (int i = 0; i < 64; i++){
      uint32_t S1 = nh_ror32(e, 6) ^ nh_ror32(e, 11) ^ nh_ror32(e, 25);
      uint32_t ch = (e & f) ^ (~e & g);
      uint32_t t1 = hh + S1 + ch + K[i] + w[i];
      uint32_t S0 = nh_ror32(a, 2) ^ nh_ror32(a, 13) ^ nh_ror32(a, 22);
      uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
      uint32_t t2 = S0 + maj;
      hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  free(buf);
  for (int i = 0; i < 8; i++){ out[4*i] = (uint8_t)(h[i] >> 24); out[4*i+1] = (uint8_t)(h[i] >> 16); out[4*i+2] = (uint8_t)(h[i] >> 8); out[4*i+3] = (uint8_t)h[i]; }
}
static void nh_sha512(const uint8_t* msg, size_t len, uint8_t out[64]){
  static const uint64_t K[80] = {
    0x428a2f98d728ae22ULL,0x7137449123ef65cdULL,0xb5c0fbcfec4d3b2fULL,0xe9b5dba58189dbbcULL,0x3956c25bf348b538ULL,0x59f111f1b605d019ULL,0x923f82a4af194f9bULL,0xab1c5ed5da6d8118ULL,
    0xd807aa98a3030242ULL,0x12835b0145706fbeULL,0x243185be4ee4b28cULL,0x550c7dc3d5ffb4e2ULL,0x72be5d74f27b896fULL,0x80deb1fe3b1696b1ULL,0x9bdc06a725c71235ULL,0xc19bf174cf692694ULL,
    0xe49b69c19ef14ad2ULL,0xefbe4786384f25e3ULL,0x0fc19dc68b8cd5b5ULL,0x240ca1cc77ac9c65ULL,0x2de92c6f592b0275ULL,0x4a7484aa6ea6e483ULL,0x5cb0a9dcbd41fbd4ULL,0x76f988da831153b5ULL,
    0x983e5152ee66dfabULL,0xa831c66d2db43210ULL,0xb00327c898fb213fULL,0xbf597fc7beef0ee4ULL,0xc6e00bf33da88fc2ULL,0xd5a79147930aa725ULL,0x06ca6351e003826fULL,0x142929670a0e6e70ULL,
    0x27b70a8546d22ffcULL,0x2e1b21385c26c926ULL,0x4d2c6dfc5ac42aedULL,0x53380d139d95b3dfULL,0x650a73548baf63deULL,0x766a0abb3c77b2a8ULL,0x81c2c92e47edaee6ULL,0x92722c851482353bULL,
    0xa2bfe8a14cf10364ULL,0xa81a664bbc423001ULL,0xc24b8b70d0f89791ULL,0xc76c51a30654be30ULL,0xd192e819d6ef5218ULL,0xd69906245565a910ULL,0xf40e35855771202aULL,0x106aa07032bbd1b8ULL,
    0x19a4c116b8d2d0c8ULL,0x1e376c085141ab53ULL,0x2748774cdf8eeb99ULL,0x34b0bcb5e19b48a8ULL,0x391c0cb3c5c95a63ULL,0x4ed8aa4ae3418acbULL,0x5b9cca4f7763e373ULL,0x682e6ff3d6b2b8a3ULL,
    0x748f82ee5defb2fcULL,0x78a5636f43172f60ULL,0x84c87814a1f0ab72ULL,0x8cc702081a6439ecULL,0x90befffa23631e28ULL,0xa4506cebde82bde9ULL,0xbef9a3f7b2c67915ULL,0xc67178f2e372532bULL,
    0xca273eceea26619cULL,0xd186b8c721c0c207ULL,0xeada7dd6cde0eb1eULL,0xf57d4f7fee6ed178ULL,0x06f067aa72176fbaULL,0x0a637dc5a2c898a6ULL,0x113f9804bef90daeULL,0x1b710b35131c471bULL,
    0x28db77f523047d84ULL,0x32caab7b40c72493ULL,0x3c9ebe0a15c9bebcULL,0x431d67c49c100d4cULL,0x4cc5d4becb3e42b6ULL,0x597f299cfc657e2aULL,0x5fcb6fab3ad6faecULL,0x6c44198c4a475817ULL };
  uint64_t h[8] = { 0x6a09e667f3bcc908ULL,0xbb67ae8584caa73bULL,0x3c6ef372fe94f82bULL,0xa54ff53a5f1d36f1ULL,0x510e527fade682d1ULL,0x9b05688c2b3e6c1fULL,0x1f83d9abfb41bd6bULL,0x5be0cd19137e2179ULL };
  size_t total = ((len + 16) / 128 + 1) * 128;
  uint8_t* buf = (uint8_t*)calloc(total, 1);
  memcpy(buf, msg, len); buf[len] = 0x80;
  uint64_t bits = (uint64_t)len * 8;
  for (int i = 0; i < 8; i++) buf[total - 1 - i] = (uint8_t)(bits >> (8 * i));
  for (size_t off = 0; off < total; off += 128){
    uint64_t w[80];
    for (int i = 0; i < 16; i++){ w[i] = 0; for (int j = 0; j < 8; j++) w[i] = (w[i] << 8) | buf[off + 8*i + j]; }
    for (int i = 16; i < 80; i++){
      uint64_t s0 = nh_ror64(w[i-15], 1) ^ nh_ror64(w[i-15], 8) ^ (w[i-15] >> 7);
      uint64_t s1 = nh_ror64(w[i-2], 19) ^ nh_ror64(w[i-2], 61) ^ (w[i-2] >> 6);
      w[i] = w[i-16] + s0 + w[i-7] + s1;
    }
    uint64_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (int i = 0; i < 80; i++){
      uint64_t S1 = nh_ror64(e, 14) ^ nh_ror64(e, 18) ^ nh_ror64(e, 41);
      uint64_t ch = (e & f) ^ (~e & g);
      uint64_t t1 = hh + S1 + ch + K[i] + w[i];
      uint64_t S0 = nh_ror64(a, 28) ^ nh_ror64(a, 34) ^ nh_ror64(a, 39);
      uint64_t maj = (a & b) ^ (a & c) ^ (b & c);
      uint64_t t2 = S0 + maj;
      hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  free(buf);
  for (int i = 0; i < 8; i++) for (int j = 0; j < 8; j++) out[8*i + j] = (uint8_t)(h[i] >> (56 - 8 * j));
}
/* hash(algorithm, data) -> the digest as a Uint8Array; algorithm: "md5", "sha1", "sha256", "sha512" */
static tsv nh_hash(tsv* a, int n){
  tsv alg = nh_arg(a, n, 0);
  if (!ts_is_str(alg)) ts_throw_type_error_msg("The \"algorithm\" argument must be of type string");
  uint32_t alen; char* name = ts_string_utf8_copy(alg, &alen);
  nh_bytes b = nh_bytes_of(nh_arg(a, n, 1));
  uint8_t digest[64]; uint32_t dlen = 0;
  if (!strcmp(name, "md5")){ nh_md5(b.data, b.length, digest); dlen = 16; }
  else if (!strcmp(name, "sha1")){ nh_sha1(b.data, b.length, digest); dlen = 20; }
  else if (!strcmp(name, "sha256")){ nh_sha256(b.data, b.length, digest); dlen = 32; }
  else if (!strcmp(name, "sha512")){ nh_sha512(b.data, b.length, digest); dlen = 64; }
  free(name); free(b.owned);
  if (dlen == 0) return TS_UNDEFINED;
  tsv len = ts_num((double)dlen);
  tsv out = ts_new_typed_array(TS_TA_UINT8, &len, 1);
  memcpy(((ts_typedarray*)ts_ptr(out))->data, digest, dlen);
  return out;
}
/* ---- file descriptors the loop watches (a child's pipes, standard input) and
   child processes (node:child_process). A watch reads what is ready into a
   Uint8Array for its onData callback and calls onEnd at end of file; a child
   is reaped from the loop (SIGCHLD wakes the poll through a self-pipe) and its
   onExit callback gets the code or the signal's name. ---- */
typedef struct nh_fdwatch { uint32_t id; int fd; tsv on_data, on_end; int active; struct nh_fdwatch* next; } nh_fdwatch;
static nh_fdwatch* g_nh_fdwatches = NULL;
static int g_nh_active_fdwatches = 0;
typedef struct nh_child { pid_t pid; tsv on_exit; int active; struct nh_child* next; } nh_child;
static nh_child* g_nh_children = NULL;
static int g_nh_pending_children = 0;
static int g_nh_sigchld_pipe[2] = { -1, -1 };
static void nh_sigchld(int sig){ (void)sig; int e = errno; if (g_nh_sigchld_pipe[1] >= 0){ char c = 1; (void)!write(g_nh_sigchld_pipe[1], &c, 1); } errno = e; }
static void nh_ensure_sigchld(void){
  if (g_nh_sigchld_pipe[0] >= 0) return;
  if (pipe(g_nh_sigchld_pipe)) ts_abort_msg("pipe for SIGCHLD failed");
  fcntl(g_nh_sigchld_pipe[0], F_SETFL, O_NONBLOCK); fcntl(g_nh_sigchld_pipe[1], F_SETFL, O_NONBLOCK);
  fcntl(g_nh_sigchld_pipe[0], F_SETFD, FD_CLOEXEC); fcntl(g_nh_sigchld_pipe[1], F_SETFD, FD_CLOEXEC);
  struct sigaction sa; memset(&sa, 0, sizeof sa);
  sa.sa_handler = nh_sigchld; sa.sa_flags = SA_RESTART | SA_NOCLDSTOP; sigemptyset(&sa.sa_mask);
  sigaction(SIGCHLD, &sa, NULL);
}
static const char* nh_signal_name(int sig){
  switch (sig){
    case SIGHUP: return "SIGHUP"; case SIGINT: return "SIGINT"; case SIGQUIT: return "SIGQUIT"; case SIGILL: return "SIGILL"; case SIGTRAP: return "SIGTRAP";
    case SIGABRT: return "SIGABRT"; case SIGBUS: return "SIGBUS"; case SIGFPE: return "SIGFPE"; case SIGKILL: return "SIGKILL"; case SIGUSR1: return "SIGUSR1";
    case SIGSEGV: return "SIGSEGV"; case SIGUSR2: return "SIGUSR2"; case SIGPIPE: return "SIGPIPE"; case SIGALRM: return "SIGALRM"; case SIGTERM: return "SIGTERM";
    case SIGCHLD: return "SIGCHLD"; case SIGCONT: return "SIGCONT"; case SIGSTOP: return "SIGSTOP"; case SIGTSTP: return "SIGTSTP"; case SIGWINCH: return "SIGWINCH";
    default: return "SIGUNKNOWN";
  }
}
static int nh_signal_number(tsv v){
  if (ts_is_num(v)) return (int)ts_to_num(v);
  if (!ts_is_str(v)) return SIGTERM;
  uint32_t len; char* name = ts_string_utf8_copy(v, &len);
  int sig = -1;
  static const struct { const char* n; int s; } table[] = { {"SIGHUP",SIGHUP},{"SIGINT",SIGINT},{"SIGQUIT",SIGQUIT},{"SIGILL",SIGILL},{"SIGTRAP",SIGTRAP},{"SIGABRT",SIGABRT},{"SIGBUS",SIGBUS},{"SIGFPE",SIGFPE},{"SIGKILL",SIGKILL},{"SIGUSR1",SIGUSR1},{"SIGSEGV",SIGSEGV},{"SIGUSR2",SIGUSR2},{"SIGPIPE",SIGPIPE},{"SIGALRM",SIGALRM},{"SIGTERM",SIGTERM},{"SIGCHLD",SIGCHLD},{"SIGCONT",SIGCONT},{"SIGSTOP",SIGSTOP},{"SIGTSTP",SIGTSTP},{"SIGWINCH",SIGWINCH} };
  for (size_t i = 0; i < sizeof table / sizeof table[0]; i++) if (!strcmp(name, table[i].n)) sig = table[i].s;
  free(name);
  return sig;
}
/* the argv / envp arrays of a spawn: NULL-terminated copies of the strings of a TS array */
static char** nh_string_vector(tsv arr, uint32_t* count){
  uint32_t n = ts_is_array(arr) ? ts_array_len(arr) : 0;
  char** out = (char**)calloc((size_t)n + 1, sizeof(char*));
  for (uint32_t i = 0; i < n; i++){
    tsv v = ts_array_get(arr, i);
    if (!ts_is_str(v)) v = ts_to_string_v(v);
    uint32_t len; out[i] = ts_string_utf8_copy(v, &len);
  }
  if (count) *count = n;
  return out;
}
static void nh_free_vector(char** v){ if (!v) return; for (char** p = v; *p; p++) free(*p); free(v); }
typedef struct { int in[2], out[2], err[2]; } nh_stdio_pipes;
/* fork and exec `file` with `argv`; mode per stream: 0 pipe, 1 inherit, 2 ignore. Returns the pid or -errno. */
static pid_t nh_fork_exec(char** argv, const char* cwd, char** envp, int in_mode, int out_mode, int err_mode, nh_stdio_pipes* pp){
  int modes[3] = { in_mode, out_mode, err_mode };
  int (*pipes[3])[2] = { &pp->in, &pp->out, &pp->err };
  for (int i = 0; i < 3; i++){ (*pipes[i])[0] = (*pipes[i])[1] = -1; if (modes[i] == 0 && pipe(*pipes[i])) return -errno; }
  int errpipe[2]; if (pipe(errpipe)) return -errno;
  fcntl(errpipe[1], F_SETFD, FD_CLOEXEC);
  fflush(stdout); fflush(stderr);
  pid_t pid = fork();
  if (pid < 0){ int e = errno; close(errpipe[0]); close(errpipe[1]); return -e; }
  if (pid == 0){
    /* the child: wire the standard streams, change directory, exec */
    if (in_mode == 0){ dup2(pp->in[0], 0); } else if (in_mode == 2){ int fd = open("/dev/null", O_RDONLY); if (fd >= 0){ dup2(fd, 0); close(fd); } }
    if (out_mode == 0){ dup2(pp->out[1], 1); } else if (out_mode == 2){ int fd = open("/dev/null", O_WRONLY); if (fd >= 0){ dup2(fd, 1); close(fd); } }
    if (err_mode == 0){ dup2(pp->err[1], 2); } else if (err_mode == 2){ int fd = open("/dev/null", O_WRONLY); if (fd >= 0){ dup2(fd, 2); close(fd); } }
    for (int i = 0; i < 3; i++){ if ((*pipes[i])[0] > 2) close((*pipes[i])[0]); if ((*pipes[i])[1] > 2) close((*pipes[i])[1]); }
    if (cwd && chdir(cwd)){ int e = errno; (void)!write(errpipe[1], &e, sizeof e); _exit(127); }
    signal(SIGPIPE, SIG_DFL);
    if (envp){ extern char** environ; environ = envp; }
    execvp(argv[0], argv);
    int e = errno; (void)!write(errpipe[1], &e, sizeof e); _exit(127);
  }
  close(errpipe[1]);
  if (in_mode == 0) close(pp->in[0]);
  if (out_mode == 0) close(pp->out[1]);
  if (err_mode == 0) close(pp->err[1]);
  int child_errno = 0; ssize_t r;
  do { r = read(errpipe[0], &child_errno, sizeof child_errno); } while (r < 0 && errno == EINTR);
  close(errpipe[0]);
  if (r == (ssize_t)sizeof child_errno){
    int st; waitpid(pid, &st, 0);
    if (in_mode == 0) close(pp->in[1]);
    if (out_mode == 0) close(pp->out[0]);
    if (err_mode == 0) close(pp->err[0]);
    return -child_errno;
  }
  return pid;
}
static void nh_append(uint8_t** buf, size_t* len, size_t* cap, const uint8_t* data, size_t n){
  if (*len + n > *cap){ *cap = (*cap ? *cap * 2 : 65536); while (*cap < *len + n) *cap *= 2; *buf = (uint8_t*)realloc(*buf, *cap); }
  memcpy(*buf + *len, data, n); *len += n;
}
static tsv nh_bytes_value(const uint8_t* data, size_t len){
  tsv n = ts_num((double)len);
  tsv out = ts_new_typed_array(TS_TA_UINT8, &n, 1);
  if (len) memcpy(((ts_typedarray*)ts_ptr(out))->data, data, len);
  return out;
}
/* spawnSync(argv, cwd, env, stdinBytes, timeoutMs, killSignal, stdoutMode, stderrMode)
   -> [status | null, signal | undefined, stdout, stderr, errorCode | undefined, pid] */
static tsv nh_spawn_sync(tsv* a, int n){
  char** argv = nh_string_vector(nh_arg(a, n, 0), NULL);
  tsv cwdv = nh_arg(a, n, 1); char* cwd = ts_is_str(cwdv) ? nh_path_of(cwdv) : NULL;
  tsv envv = nh_arg(a, n, 2); char** envp = ts_is_array(envv) ? nh_string_vector(envv, NULL) : NULL;
  tsv inv = nh_arg(a, n, 3);
  nh_bytes input = { NULL, 0, NULL };
  int in_mode = 2;
  if (ts_is_str(inv) || ts_is_typed_array(inv)){ input = nh_bytes_of(inv); in_mode = 0; }
  else if (ts_is_num(inv)) in_mode = (int)ts_to_num(inv);   /* 1 inherit, 2 ignore */
  double timeout_ms = nh_num(a, n, 4, 0);
  int kill_sig = nh_signal_number(nh_arg(a, n, 5)); if (kill_sig < 0) kill_sig = SIGTERM;
  int out_mode = (int)nh_num(a, n, 6, 0), err_mode = (int)nh_num(a, n, 7, 0);
  nh_stdio_pipes pp;
  pid_t pid = nh_fork_exec(argv, cwd, envp, in_mode, out_mode, err_mode, &pp);
  nh_free_vector(argv); nh_free_vector(envp); free(cwd);
  tsv result = ts_new_array(0); ts_gc_root(&result);
  if (pid < 0){
    nh_last_errno = -pid;
    free(input.owned);
    ts_array_push(result, TS_NULL); ts_array_push(result, TS_UNDEFINED);
    tsv e1 = nh_bytes_value(NULL, 0); ts_array_push(result, e1);
    tsv e2 = nh_bytes_value(NULL, 0); ts_array_push(result, e2);
    tsv code = nh_string(nh_errno_name(-pid)); ts_array_push(result, code);
    ts_array_push(result, ts_num(0));
    ts_gc_unroot(1);
    return result;
  }
  uint8_t *obuf = NULL, *ebuf = NULL; size_t olen = 0, ocap = 0, elen = 0, ecap = 0;
  size_t written = 0;
  int in_fd = in_mode == 0 ? pp.in[1] : -1, out_fd = out_mode == 0 ? pp.out[0] : -1, err_fd = err_mode == 0 ? pp.err[0] : -1;
  if (in_fd >= 0){ fcntl(in_fd, F_SETFL, O_NONBLOCK); if (input.length == 0){ close(in_fd); in_fd = -1; } }
  double deadline = timeout_ms > 0 ? nh_mono_ms() + timeout_ms : 0;
  int timed_out = 0;
  uint8_t chunk[65536];
  signal(SIGPIPE, SIG_IGN);
  while (in_fd >= 0 || out_fd >= 0 || err_fd >= 0){
    struct pollfd fds[3]; int k = 0, idx_in = -1, idx_out = -1, idx_err = -1;
    if (in_fd >= 0){ fds[k].fd = in_fd; fds[k].events = POLLOUT; idx_in = k++; }
    if (out_fd >= 0){ fds[k].fd = out_fd; fds[k].events = POLLIN; idx_out = k++; }
    if (err_fd >= 0){ fds[k].fd = err_fd; fds[k].events = POLLIN; idx_err = k++; }
    int wait = -1;
    if (deadline > 0){ double remain = deadline - nh_mono_ms(); wait = remain <= 0 ? 0 : (int)(remain + 0.999); }
    int r = poll(fds, (nfds_t)k, wait);
    if (r < 0){ if (errno == EINTR) continue; break; }
    if (r == 0 && deadline > 0 && nh_mono_ms() >= deadline){ timed_out = 1; kill(pid, kill_sig); deadline = 0; continue; }
    if (idx_in >= 0 && (fds[idx_in].revents & (POLLOUT | POLLERR | POLLHUP))){
      ssize_t w = write(in_fd, input.data + written, input.length - written);
      if (w > 0) written += (size_t)w;
      if (w < 0 && errno != EAGAIN && errno != EINTR){ close(in_fd); in_fd = -1; }
      else if (written >= input.length){ close(in_fd); in_fd = -1; }
    }
    if (idx_out >= 0 && (fds[idx_out].revents & (POLLIN | POLLHUP | POLLERR))){
      ssize_t got = read(out_fd, chunk, sizeof chunk);
      if (got > 0) nh_append(&obuf, &olen, &ocap, chunk, (size_t)got); else if (got == 0 || errno != EINTR){ close(out_fd); out_fd = -1; }
    }
    if (idx_err >= 0 && (fds[idx_err].revents & (POLLIN | POLLHUP | POLLERR))){
      ssize_t got = read(err_fd, chunk, sizeof chunk);
      if (got > 0) nh_append(&ebuf, &elen, &ecap, chunk, (size_t)got); else if (got == 0 || errno != EINTR){ close(err_fd); err_fd = -1; }
    }
  }
  free(input.owned);
  int status = 0;
  while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
  if (WIFEXITED(status)){ ts_array_push(result, ts_num((double)WEXITSTATUS(status))); ts_array_push(result, TS_UNDEFINED); }
  else if (WIFSIGNALED(status)){ ts_array_push(result, TS_NULL); tsv sn = nh_string(nh_signal_name(WTERMSIG(status))); ts_array_push(result, sn); }
  else { ts_array_push(result, TS_NULL); ts_array_push(result, TS_UNDEFINED); }
  tsv o = nh_bytes_value(obuf, olen); ts_array_push(result, o);
  tsv e = nh_bytes_value(ebuf, elen); ts_array_push(result, e);
  free(obuf); free(ebuf);
  if (timed_out){ tsv code = nh_string("ETIMEDOUT"); ts_array_push(result, code); } else ts_array_push(result, TS_UNDEFINED);
  ts_array_push(result, ts_num((double)pid));
  ts_gc_unroot(1);
  return result;
}
/* spawn(argv, cwd, env, stdinMode, stdoutMode, stderrMode) -> [pid, stdinFd, stdoutFd, stderrFd] | errorCode */
static tsv nh_spawn(tsv* a, int n){
  nh_ensure_sigchld();
  char** argv = nh_string_vector(nh_arg(a, n, 0), NULL);
  tsv cwdv = nh_arg(a, n, 1); char* cwd = ts_is_str(cwdv) ? nh_path_of(cwdv) : NULL;
  tsv envv = nh_arg(a, n, 2); char** envp = ts_is_array(envv) ? nh_string_vector(envv, NULL) : NULL;
  int in_mode = (int)nh_num(a, n, 3, 0), out_mode = (int)nh_num(a, n, 4, 0), err_mode = (int)nh_num(a, n, 5, 0);
  nh_stdio_pipes pp;
  pid_t pid = nh_fork_exec(argv, cwd, envp, in_mode, out_mode, err_mode, &pp);
  nh_free_vector(argv); nh_free_vector(envp); free(cwd);
  if (pid < 0){ nh_last_errno = -pid; return nh_string(nh_errno_name(-pid)); }
  int fds[3] = { in_mode == 0 ? pp.in[1] : -1, out_mode == 0 ? pp.out[0] : -1, err_mode == 0 ? pp.err[0] : -1 };
  for (int i = 0; i < 3; i++) if (fds[i] >= 0) fcntl(fds[i], F_SETFD, FD_CLOEXEC);
  nh_child* c = (nh_child*)calloc(1, sizeof *c);
  c->pid = pid; c->on_exit = TS_UNDEFINED; c->active = 1; c->next = g_nh_children; g_nh_children = c;
  g_nh_pending_children++;
  tsv out = ts_new_array(0); ts_gc_root(&out);
  ts_array_push(out, ts_num((double)pid));
  for (int i = 0; i < 3; i++) ts_array_push(out, ts_num((double)fds[i]));
  ts_gc_unroot(1);
  return out;
}
/* onChildExit(pid, callback(code | null, signal | null)) */
static tsv nh_on_child_exit(tsv* a, int n){
  pid_t pid = (pid_t)nh_num(a, n, 0, 0);
  for (nh_child* c = g_nh_children; c; c = c->next) if (c->pid == pid){ c->on_exit = nh_arg(a, n, 1); return ts_bool(1); }
  return ts_bool(0);
}
/* the children that exited: their callbacks (called from the loop) */
static void nh_reap_children(void){
  if (g_nh_sigchld_pipe[0] >= 0){ char buf[64]; while (read(g_nh_sigchld_pipe[0], buf, sizeof buf) > 0) {} }
  for (nh_child** pp = &g_nh_children; *pp; ){
    nh_child* c = *pp;
    int status = 0;
    pid_t r = c->active ? waitpid(c->pid, &status, WNOHANG) : 0;
    if (r == c->pid || (r < 0 && errno == ECHILD)){
      *pp = c->next;
      g_nh_pending_children--;
      tsv cb = c->on_exit;
      tsv args[2] = { TS_NULL, TS_NULL };
      if (r == c->pid && WIFEXITED(status)) args[0] = ts_num((double)WEXITSTATUS(status));
      else if (r == c->pid && WIFSIGNALED(status)) args[1] = nh_string(nh_signal_name(WTERMSIG(status)));
      else args[0] = ts_num(-1);
      free(c);
      if (ts_is_func(cb)){ ts_gc_root(&cb); ts_gc_root(&args[1]); (void)ts_call_value(cb, args, 2); ts_gc_unroot(2); nh_drain_ticks_and_microtasks(); }
      continue;
    }
    pp = &c->next;
  }
}
/* watchFd(fd, onData(bytes), onEnd()) -> id: the loop reads what arrives */
static tsv nh_watch_fd(tsv* a, int n){
  nh_fdwatch* w = (nh_fdwatch*)calloc(1, sizeof *w);
  w->id = g_nh_next_id++; w->fd = (int)nh_num(a, n, 0, -1); w->on_data = nh_arg(a, n, 1); w->on_end = nh_arg(a, n, 2); w->active = 1;
  fcntl(w->fd, F_SETFL, fcntl(w->fd, F_GETFL) | O_NONBLOCK);
  w->next = g_nh_fdwatches; g_nh_fdwatches = w;
  g_nh_active_fdwatches++;
  return ts_num((double)w->id);
}
static void nh_fdwatch_end(nh_fdwatch* w, int close_fd){
  if (!w->active) return;
  w->active = 0; g_nh_active_fdwatches--;
  if (close_fd && w->fd > 2) close(w->fd);
  tsv cb = w->on_end; w->on_end = TS_UNDEFINED; w->on_data = TS_UNDEFINED;
  if (ts_is_func(cb)){ ts_gc_root(&cb); (void)ts_call_value(cb, NULL, 0); ts_gc_unroot(1); nh_drain_ticks_and_microtasks(); }
}
static tsv nh_unwatch_fd(tsv* a, int n){
  uint32_t id = (uint32_t)nh_num(a, n, 0, 0);
  for (nh_fdwatch* w = g_nh_fdwatches; w; w = w->next) if (w->id == id && w->active){ w->active = 0; g_nh_active_fdwatches--; w->on_end = TS_UNDEFINED; w->on_data = TS_UNDEFINED; }
  return TS_UNDEFINED;
}
static void nh_fdwatch_read(nh_fdwatch* w){
  uint8_t chunk[65536];
  ssize_t got;
  do { got = read(w->fd, chunk, sizeof chunk); } while (got < 0 && errno == EINTR);
  if (got > 0){
    tsv bytes = nh_bytes_value(chunk, (size_t)got);
    tsv cb = w->on_data;
    if (ts_is_func(cb)){ ts_gc_root(&cb); ts_gc_root(&bytes); (void)ts_call_value(cb, &bytes, 1); ts_gc_unroot(2); nh_drain_ticks_and_microtasks(); }
    return;
  }
  if (got < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return;
  nh_fdwatch_end(w, 1);
}
static void nh_fdwatches_prune(void){
  for (nh_fdwatch** pp = &g_nh_fdwatches; *pp; ){ nh_fdwatch* w = *pp; if (!w->active){ *pp = w->next; free(w); } else pp = &w->next; }
}
/* the loop's wait: the workers' pipes, the parent's, the watched fds and the SIGCHLD pipe in one poll */
static void nh_wait(int timeout_ms){
  int nw = 0; for (ts_watch* w = g_watches; w; w = w->next) nw++;
  int parent = g_parent_watching && g_parent_fd >= 0;
  int nf = 0; for (nh_fdwatch* w = g_nh_fdwatches; w; w = w->next) if (w->active) nf++;
  int sig = g_nh_sigchld_pipe[0] >= 0 && g_nh_pending_children > 0;
  int total = nw + parent + nf + sig;
  if (total == 0){ nh_sleep_ms(timeout_ms); return; }
  struct pollfd* fds = (struct pollfd*)calloc((size_t)total, sizeof *fds);
  void** owners = (void**)calloc((size_t)total, sizeof(void*));
  int* kinds = (int*)calloc((size_t)total, sizeof(int));   /* 0 worker, 1 parent, 2 fdwatch, 3 sigchld */
  int i = 0;
  for (ts_watch* w = g_watches; w; w = w->next){ fds[i].fd = w->fd; fds[i].events = POLLIN; owners[i] = w; kinds[i] = 0; i++; }
  if (parent){ fds[i].fd = g_parent_fd; fds[i].events = POLLIN; kinds[i] = 1; i++; }
  for (nh_fdwatch* w = g_nh_fdwatches; w; w = w->next) if (w->active){ fds[i].fd = w->fd; fds[i].events = POLLIN; owners[i] = w; kinds[i] = 2; i++; }
  if (sig){ fds[i].fd = g_nh_sigchld_pipe[0]; fds[i].events = POLLIN; kinds[i] = 3; i++; }
  int r = poll(fds, (nfds_t)i, timeout_ms);
  if (r > 0) for (int k = 0; k < i; k++){
    if (!(fds[k].revents & (POLLIN | POLLHUP | POLLERR))) continue;
    if (kinds[k] == 0) watch_read((ts_watch*)owners[k]);
    else if (kinds[k] == 1) parent_read();
    else if (kinds[k] == 2) nh_fdwatch_read((nh_fdwatch*)owners[k]);
  }
  free(fds); free(owners); free(kinds);
  nh_fdwatches_prune();
  if (g_nh_pending_children) nh_reap_children();
}
/* A forked worker starts with none of the parent's pending work (Node: a fresh isolate):
   the timers, immediates, ticks, watched fds and child processes are the parent's. The
   records are the child's copies of the parent's heap, left as they are. */
static void nh_fork_child_reset(void){
  g_nh_timers = NULL; g_nh_refed_timers = 0;
  g_nh_imm_head = g_nh_imm_tail = NULL; g_nh_refed_immediates = 0;
  g_nh_tick_head = g_nh_tick_tail = NULL;
  g_nh_fdwatches = NULL; g_nh_active_fdwatches = 0;
  g_nh_children = NULL; g_nh_pending_children = 0;
  if (g_nh_sigchld_pipe[0] >= 0){ close(g_nh_sigchld_pipe[0]); close(g_nh_sigchld_pipe[1]); g_nh_sigchld_pipe[0] = g_nh_sigchld_pipe[1] = -1; }
}
static int nh_io_alive(void){ return g_nh_active_fdwatches > 0 || g_nh_pending_children > 0; }
static void nh_mark_io_roots(int young){
  for (nh_fdwatch* w = g_nh_fdwatches; w; w = w->next){ gc_visit_slot(&w->on_data, young, 0, 1); gc_visit_slot(&w->on_end, young, 0, 1); }
  for (nh_child* c = g_nh_children; c; c = c->next) gc_visit_slot(&c->on_exit, young, 0, 1);
}
/* createObject(proto) and relink(obj, proto): Object.create and Object.setPrototypeOf for
   the library's own objects (Buffer's prototype over Uint8Array's, util.inherits). A chain
   that reaches a registered class with struct fields, or an object that is a class instance
   or a class prototype, is refused (TypeError): the typed-slow flag is never raised, and the
   closed-receivers proof has no site to count here. */
/* node:worker_threads (docs/node_compat_design.md, N5b): the workers are forks of the
   initialized program running an entry function of it, the one the exporter made of the
   worker's module (docs/fork_workers_design.md). */
static tsv nh_set_worker_start(tsv* a, int n){ ts_worker_set_start(nh_arg(a, n, 0)); return TS_UNDEFINED; }
static tsv nh_is_worker(tsv* a, int n){ (void)a; (void)n; return ts_bool(ts_worker_is_worker()); }
static tsv nh_thread_id(tsv* a, int n){ (void)a; (void)n; return ts_num((double)ts_worker_thread_id()); }
static tsv nh_worker_data(tsv* a, int n){ (void)a; (void)n; return ts_worker_data(); }
static tsv nh_spawn_worker(tsv* a, int n){
  tsv entry = nh_arg(a, n, 0), data = nh_arg(a, n, 1);
  int shared = ts_truthy(nh_arg(a, n, 2));
  int id = ts_worker_start(entry, data, shared);
  ts_worker_on_message(id, nh_arg(a, n, 3));
  ts_worker_on_error(id, nh_arg(a, n, 4));
  ts_worker_on_exit(id, nh_arg(a, n, 5));
  return ts_num((double)id);
}
static tsv nh_send_to_worker(tsv* a, int n){ ts_worker_send((int)nh_num(a, n, 0, 0), nh_arg(a, n, 1)); return TS_UNDEFINED; }
static tsv nh_kill_worker(tsv* a, int n){ ts_worker_kill((int)nh_num(a, n, 0, 0)); return TS_UNDEFINED; }
static tsv nh_worker_ref(tsv* a, int n){ ts_worker_ref((int)nh_num(a, n, 0, 0), ts_truthy(nh_arg(a, n, 1))); return TS_UNDEFINED; }
static tsv nh_post_message(tsv* a, int n){ ts_worker_post(nh_arg(a, n, 0)); return TS_UNDEFINED; }
static tsv nh_on_parent_message(tsv* a, int n){ ts_worker_on_parent_message(nh_arg(a, n, 0)); return TS_UNDEFINED; }
static tsv nh_close_parent_port(tsv* a, int n){ (void)a; (void)n; ts_worker_parent_close(); return TS_UNDEFINED; }
static tsv nh_object_create(tsv* a, int n){
  tsv proto = nh_arg(a, n, 0);
  if (ts_is_obj(proto) && proto_chain_has_struct_class(proto)) ts_throw_type_error_msg("createObject: the prototype chain reaches a class with fields");
  return ts_object_create(proto);
}
static tsv nh_relink(tsv* a, int n){
  tsv obj = nh_arg(a, n, 0), proto = nh_arg(a, n, 1);
  if (!ts_is_obj(obj)) ts_throw_type_error_msg("relink: the object must be an object");
  ts_object* o = (ts_object*)ts_ptr(obj);
  if (o->cls != 0) ts_throw_type_error_msg("relink: a class instance or a class prototype keeps its chain");
  if (ts_is_obj(proto) && proto_chain_has_struct_class(proto)) ts_throw_type_error_msg("relink: the prototype chain reaches a class with fields");
  if (!ts_is_obj(proto) && !ts_is_null(proto)) ts_throw_type_error_msg("relink: the prototype must be an object or null");
  ts_set_proto(obj, proto);
  return obj;
}
/* writeString(text, view, offset, max, kind): the bytes of `text` written into the
   Uint8Array `view` at `offset`, at most `max`, as UTF-8 (kind 0: whole characters only,
   a lone surrogate as U+FFFD), UTF-16LE (kind 1: whole units) or Latin-1 (kind 2: the low
   byte of each unit); the number of bytes written. Buffer.prototype.write and Buffer.from
   stand on it instead of a TypeScript loop over the bytes. */
static tsv nh_write_string(tsv* a, int n){
  tsv text = nh_arg(a, n, 0), view = nh_arg(a, n, 1);
  if (!ts_is_str(text)) ts_throw_type_error_msg("The \"string\" argument must be of type string");
  if (!ts_is_typed_array(view)) ts_throw_type_error_msg("writeString: the target must be a Uint8Array");
  ts_typedarray* t = (ts_typedarray*)ts_ptr(view);
  double offd = nh_num(a, n, 2, 0), maxd = nh_num(a, n, 3, (double)t->length);
  int kind = (int)nh_num(a, n, 4, 0);
  if (!(offd >= 0) || offd > (double)t->length) ts_throw_range_error_msg("The value of \"offset\" is out of range");
  uint32_t off = (uint32_t)offd;
  uint32_t room = (uint32_t)(maxd < 0 ? 0 : maxd);
  if (room > t->length - off) room = t->length - off;
  ts_strview x = ts_str_view_typed(text);
  uint8_t* out = (uint8_t*)t->data + off;
  uint32_t w = 0;
  /* the storage read directly: 8-bit cells hold units below 256, UTF-16 cells the units themselves */
  const uint8_t* b8 = x.data && !(x.flags & TS_STR_FLAG_UTF16) ? (const uint8_t*)x.data : NULL;
  const uint8_t* b16 = x.data && (x.flags & TS_STR_FLAG_UTF16) ? (const uint8_t*)x.data : NULL;
  if (kind == 1){
    uint32_t units = room / 2u; if (units > x.len) units = x.len;
    if (b8){ for (uint32_t i = 0; i < units; i++){ out[2*i] = b8[i]; out[2*i + 1] = 0; } }
    else if (b16){ memcpy(out, b16, (size_t)units * 2u); }
    else { for (uint32_t i = 0; i < units; i++){ uint16_t cu = ts_str_cu_at_view(x, i); out[2*i] = (uint8_t)cu; out[2*i + 1] = (uint8_t)(cu >> 8); } }
    w = units * 2u;
  } else if (kind == 2){
    uint32_t units = room < x.len ? room : x.len;
    if (b8){ memcpy(out, b8, units); }
    else if (b16){ for (uint32_t i = 0; i < units; i++) out[i] = b16[2*i]; }
    else { for (uint32_t i = 0; i < units; i++) out[i] = (uint8_t)ts_str_cu_at_view(x, i); }
    w = units;
  } else if (b8){
    /* 8-bit storage: one byte per unit below 0x80, two above */
    for (uint32_t i = 0; i < x.len; i++){
      uint32_t cp = b8[i];
      if (cp < 0x80u){ if (w + 1 > room) break; out[w++] = (uint8_t)cp; }
      else { if (w + 2 > room) break; out[w] = (uint8_t)(0xC0 | (cp >> 6)); out[w + 1] = (uint8_t)(0x80 | (cp & 0x3F)); w += 2; }
    }
  } else {
    for (uint32_t i = 0; i < x.len; i++){
      uint32_t cp = b16 ? ((uint32_t)b16[2*i] | ((uint32_t)b16[2*i + 1] << 8)) : ts_str_cu_at_view(x, i);
      uint32_t adv = 1;
      if (cp >= 0xD800u && cp <= 0xDBFFu && i + 1 < x.len){
        uint32_t lo = b16 ? ((uint32_t)b16[2*i + 2] | ((uint32_t)b16[2*i + 3] << 8)) : ts_str_cu_at_view(x, i + 1);
        if (lo >= 0xDC00u && lo <= 0xDFFFu){ cp = 0x10000u + ((cp - 0xD800u) << 10) + (lo - 0xDC00u); adv = 2; }
        else cp = 0xFFFDu;
      } else if (cp >= 0xD800u && cp <= 0xDFFFu) cp = 0xFFFDu;
      uint32_t need = cp < 0x80u ? 1 : cp < 0x800u ? 2 : cp < 0x10000u ? 3 : 4;
      if (w + need > room) break;
      if (need == 1) out[w] = (uint8_t)cp;
      else if (need == 2){ out[w] = (uint8_t)(0xC0 | (cp >> 6)); out[w + 1] = (uint8_t)(0x80 | (cp & 0x3F)); }
      else if (need == 3){ out[w] = (uint8_t)(0xE0 | (cp >> 12)); out[w + 1] = (uint8_t)(0x80 | ((cp >> 6) & 0x3F)); out[w + 2] = (uint8_t)(0x80 | (cp & 0x3F)); }
      else { out[w] = (uint8_t)(0xF0 | (cp >> 18)); out[w + 1] = (uint8_t)(0x80 | ((cp >> 12) & 0x3F)); out[w + 2] = (uint8_t)(0x80 | ((cp >> 6) & 0x3F)); out[w + 3] = (uint8_t)(0x80 | (cp & 0x3F)); }
      w += need; i += adv - 1;
    }
  }
  return ts_num((double)w);
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
  nh_method(host, "hash", nh_hash, 2);
  nh_method(host, "createObject", nh_object_create, 1);
  nh_method(host, "writeString", nh_write_string, 5);
  nh_method(host, "relink", nh_relink, 2);
  nh_method(host, "inspect", nh_inspect, 1);
  nh_method(host, "atExit", nh_at_exit, 1);
  nh_method(host, "timerAdd", nh_timer_add, 4);
  nh_method(host, "timerClear", nh_timer_clear, 1);
  nh_method(host, "timerRef", nh_timer_ref, 2);
  nh_method(host, "timerHasRef", nh_timer_has_ref, 1);
  nh_method(host, "timerRefresh", nh_timer_refresh, 2);
  nh_method(host, "immediate", nh_immediate_add, 2);
  nh_method(host, "immediateClear", nh_immediate_clear, 1);
  nh_method(host, "immediateRef", nh_immediate_ref, 2);
  nh_method(host, "immediateHasRef", nh_immediate_has_ref, 1);
  nh_method(host, "nextTick", nh_next_tick, 2);
  nh_method(host, "spawnSync", nh_spawn_sync, 8);
  nh_method(host, "spawn", nh_spawn, 6);
  nh_method(host, "onChildExit", nh_on_child_exit, 2);
  nh_method(host, "watchFd", nh_watch_fd, 3);
  nh_method(host, "unwatchFd", nh_unwatch_fd, 1);
  nh_method(host, "setWorkerStart", nh_set_worker_start, 1);
  nh_method(host, "isWorker", nh_is_worker, 0);
  nh_method(host, "threadId", nh_thread_id, 0);
  nh_method(host, "workerData", nh_worker_data, 0);
  nh_method(host, "spawnWorker", nh_spawn_worker, 6);
  nh_method(host, "sendToWorker", nh_send_to_worker, 2);
  nh_method(host, "killWorker", nh_kill_worker, 1);
  nh_method(host, "workerRef", nh_worker_ref, 2);
  nh_method(host, "postMessage", nh_post_message, 1);
  nh_method(host, "onParentMessage", nh_on_parent_message, 1);
  nh_method(host, "closeParentPort", nh_close_parent_port, 0);
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
