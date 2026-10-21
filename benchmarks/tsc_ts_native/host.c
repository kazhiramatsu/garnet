/* The primitives the Node module shims of tsc-ts stand on (the TypeScript in
   garnet/), as the global `__garnetHost`: synchronous file system calls, the process's
   arguments, environment, clocks and exit. A failing call answers undefined
   (or false / -1) and leaves its errno name for `lastError()`. */
#include "ts_rt.h"
#include "host.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#include <sys/sysctl.h>
#endif

extern char** environ;
static int g_argc;
static char** g_argv;
static int g_last_errno;
static struct timespec g_start;

static tsv arg(tsv* a, int n, int i){ return i < n ? a[i] : TS_UNDEFINED; }
static char* path_of(tsv value){
  uint32_t length;
  char* result = ts_string_utf8_copy(value, &length);
  if (memchr(result, 0, length)){ free(result); ts_throw_type_error_msg("NUL in a path"); }
  return result;
}
static tsv string(const char* value){ return ts_new_string(value, (uint32_t)strlen(value)); }
static tsv fail(tsv answer){ g_last_errno = errno; return answer; }

/* the bytes of a string or a Uint8Array argument (a copy for a string) */
typedef struct { const uint8_t* data; uint32_t length; char* owned; } bytes_arg;
static bytes_arg bytes_of(tsv v){
  bytes_arg b = { NULL, 0, NULL };
  if (ts_is_typed_array(v)){
    ts_typedarray* t = (ts_typedarray*)ts_ptr(v);
    b.data = t->data; b.length = t->length;   /* a Uint8Array: one byte per element */
    return b;
  }
  uint32_t length; b.owned = ts_string_utf8_copy(v, &length);
  b.data = (const uint8_t*)b.owned; b.length = length;
  return b;
}

static tsv host_read_file(tsv* a, int n){
  char* path = path_of(arg(a, n, 0));
  int fd = open(path, O_RDONLY); free(path);
  if (fd < 0) return fail(TS_UNDEFINED);
  struct stat st;
  if (fstat(fd, &st) || !S_ISREG(st.st_mode) || (unsigned long long)st.st_size > UINT32_MAX){ g_last_errno = S_ISDIR(st.st_mode) ? EISDIR : EIO; close(fd); return TS_UNDEFINED; }
  tsv len = ts_num((double)st.st_size);
  tsv out = ts_new_typed_array(TS_TA_UINT8, &len, 1);
  ts_typedarray* t = (ts_typedarray*)ts_ptr(out);
  size_t got = 0;
  while (got < t->length){
    ssize_t r = read(fd, t->data + got, t->length - got);
    if (r < 0){ if (errno == EINTR) continue; g_last_errno = errno; close(fd); return TS_UNDEFINED; }
    if (r == 0) break;
    got += (size_t)r;
  }
  close(fd);
  return out;
}
static tsv host_write_file(tsv* a, int n){
  char* path = path_of(arg(a, n, 0));
  bytes_arg b = bytes_of(arg(a, n, 1));
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0666); free(path);
  if (fd < 0){ free(b.owned); return fail(ts_bool(0)); }
  size_t done = 0;
  while (done < b.length){
    ssize_t w = write(fd, b.data + done, b.length - done);
    if (w < 0){ if (errno == EINTR) continue; g_last_errno = errno; free(b.owned); close(fd); return ts_bool(0); }
    done += (size_t)w;
  }
  free(b.owned); close(fd);
  return ts_bool(1);
}
/* writeFd(fd, data, offset, length): bytes written, -1 on failure */
static tsv host_write_fd(tsv* a, int n){
  int fd = (int)ts_to_num(arg(a, n, 0));
  bytes_arg b = bytes_of(arg(a, n, 1));
  double off = n > 2 && ts_is_num(a[2]) ? ts_to_num(a[2]) : 0;
  double len = n > 3 && ts_is_num(a[3]) ? ts_to_num(a[3]) : (double)b.length - off;
  if (off < 0 || len < 0 || off + len > b.length){ free(b.owned); ts_throw_range_error_msg("writeFd: out of range"); }
  if (fd == 1) fflush(stdout);
  ssize_t w;
  do { w = write(fd, b.data + (size_t)off, (size_t)len); } while (w < 0 && errno == EINTR);
  if (w < 0) g_last_errno = errno;
  free(b.owned);
  return ts_num((double)w);
}
/* readFd(fd, buffer, offset, length): bytes read, -1 on failure */
static tsv host_read_fd(tsv* a, int n){
  int fd = (int)ts_to_num(arg(a, n, 0));
  tsv buf = arg(a, n, 1);
  if (!ts_is_typed_array(buf)) ts_throw_type_error_msg("readFd: a Uint8Array buffer");
  ts_typedarray* t = (ts_typedarray*)ts_ptr(buf);
  double off = ts_to_num(arg(a, n, 2)), len = ts_to_num(arg(a, n, 3));
  if (off < 0 || len < 0 || off + len > t->length) ts_throw_range_error_msg("readFd: out of range");
  ssize_t r;
  do { r = read(fd, t->data + (size_t)off, (size_t)len); } while (r < 0 && errno == EINTR);
  if (r < 0) g_last_errno = errno;
  return ts_num((double)r);
}
/* stat(path, follow): [kind, size, mtimeMs] (kind 1 file, 2 directory, 3 link, 0 other) */
static tsv host_stat(tsv* a, int n){
  char* path = path_of(arg(a, n, 0));
  int follow = ts_truthy(arg(a, n, 1));
  struct stat st;
  int rc = follow ? stat(path, &st) : lstat(path, &st);
  free(path);
  if (rc) return fail(TS_UNDEFINED);
  int kind = S_ISREG(st.st_mode) ? 1 : S_ISDIR(st.st_mode) ? 2 : S_ISLNK(st.st_mode) ? 3 : 0;
#ifdef __APPLE__
  double mtime = (double)st.st_mtimespec.tv_sec * 1e3 + (double)st.st_mtimespec.tv_nsec / 1e6;
#else
  double mtime = (double)st.st_mtim.tv_sec * 1e3 + (double)st.st_mtim.tv_nsec / 1e6;
#endif
  tsv out = ts_new_array(0); ts_gc_root(&out);
  ts_array_push(out, ts_num(kind)); ts_array_push(out, ts_num((double)st.st_size)); ts_array_push(out, ts_num(mtime));
  ts_gc_unroot(1);
  return out;
}
/* readdir(path): [names, kinds] (the kinds of stat, unfollowed links 3) */
static tsv host_readdir(tsv* a, int n){
  char* path = path_of(arg(a, n, 0));
  DIR* dir = opendir(path);
  if (!dir){ free(path); return fail(TS_UNDEFINED); }
  tsv names = ts_new_array(0); ts_gc_root(&names);
  tsv kinds = ts_new_array(0); ts_gc_root(&kinds);
  struct dirent* e;
  while ((e = readdir(dir))){
    if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
    int kind;
    if (e->d_type == DT_REG) kind = 1;
    else if (e->d_type == DT_DIR) kind = 2;
    else if (e->d_type == DT_LNK) kind = 3;
    else if (e->d_type == DT_UNKNOWN){
      size_t size = strlen(path) + strlen(e->d_name) + 2; char* full = malloc(size);
      snprintf(full, size, "%s/%s", path, e->d_name);
      struct stat st; kind = lstat(full, &st) ? 0 : S_ISREG(st.st_mode) ? 1 : S_ISDIR(st.st_mode) ? 2 : S_ISLNK(st.st_mode) ? 3 : 0;
      free(full);
    } else kind = 0;
    tsv name = string(e->d_name);
    ts_array_push(names, name);
    ts_array_push(kinds, ts_num(kind));
  }
  closedir(dir); free(path);
  tsv out = ts_new_array(0); ts_gc_root(&out);
  ts_array_push(out, names); ts_array_push(out, kinds);
  ts_gc_unroot(3);
  return out;
}
static int mkdir_p(char* path){
  struct stat st;
  if (!stat(path, &st)) return S_ISDIR(st.st_mode) ? 0 : (errno = EEXIST, -1);
  char* slash = strrchr(path, '/');
  if (slash && slash != path){
    *slash = 0; int rc = mkdir_p(path); *slash = '/';
    if (rc) return rc;
  }
  return mkdir(path, 0777) && errno != EEXIST ? -1 : 0;
}
static tsv host_mkdir(tsv* a, int n){
  char* path = path_of(arg(a, n, 0));
  int rc = ts_truthy(arg(a, n, 1)) ? mkdir_p(path) : mkdir(path, 0777);
  free(path);
  return rc ? fail(ts_bool(0)) : ts_bool(1);
}
static tsv host_realpath(tsv* a, int n){
  char* path = path_of(arg(a, n, 0)); char out[PATH_MAX];
  char* r = realpath(path, out); free(path);
  return r ? string(out) : fail(TS_UNDEFINED);
}
static tsv host_unlink(tsv* a, int n){
  char* path = path_of(arg(a, n, 0)); int rc = unlink(path); free(path);
  return rc ? fail(ts_bool(0)) : ts_bool(1);
}
static tsv host_utimes(tsv* a, int n){
  char* path = path_of(arg(a, n, 0));
  double at = ts_to_num(arg(a, n, 1)), mt = ts_to_num(arg(a, n, 2));
  struct timeval tv[2];
  tv[0].tv_sec = (time_t)(at / 1e3); tv[0].tv_usec = (suseconds_t)(fmod(at, 1e3) * 1e3);
  tv[1].tv_sec = (time_t)(mt / 1e3); tv[1].tv_usec = (suseconds_t)(fmod(mt, 1e3) * 1e3);
  int rc = utimes(path, tv); free(path);
  return rc ? fail(ts_bool(0)) : ts_bool(1);
}
static tsv host_last_error(tsv* a, int n){
  (void)a; (void)n;
  switch (g_last_errno){
    case ENOENT: return string("ENOENT");
    case EACCES: return string("EACCES");
    case EEXIST: return string("EEXIST");
    case EISDIR: return string("EISDIR");
    case ENOTDIR: return string("ENOTDIR");
    case ENOTEMPTY: return string("ENOTEMPTY");
    case EPERM: return string("EPERM");
    case EAGAIN: return string("EAGAIN");
    case ELOOP: return string("ELOOP");
    default: return string("EIO");
  }
}
static tsv host_cwd(tsv* a, int n){ (void)a; (void)n; char out[PATH_MAX]; return getcwd(out, sizeof out) ? string(out) : TS_UNDEFINED; }
static tsv host_env(tsv* a, int n){
  (void)a; (void)n;
  tsv env = ts_new_object(); ts_gc_root(&env);
  for (char** e = environ; *e; e++){
    const char* eq = strchr(*e, '=');
    if (!eq || eq == *e) continue;
    char* name = strndup(*e, (size_t)(eq - *e));
    tsv value = string(eq + 1); ts_gc_root(&value);
    ts_set_cstr(env, name, value);
    ts_gc_unroot(1); free(name);
  }
  ts_gc_unroot(1);
  return env;
}
static tsv host_argv(tsv* a, int n){
  (void)a; (void)n;
  tsv out = ts_new_array(0); ts_gc_root(&out);
  for (int i = 0; i < g_argc; i++){ tsv s = string(g_argv[i]); ts_array_push(out, s); }
  ts_gc_unroot(1);
  return out;
}
static tsv host_exec_path(tsv* a, int n){
  (void)a; (void)n;
  char out[PATH_MAX];
#ifdef __APPLE__
  uint32_t size = sizeof out; char raw[PATH_MAX];
  if (_NSGetExecutablePath(raw, &size) == 0 && realpath(raw, out)) return string(out);
#else
  ssize_t len = readlink("/proc/self/exe", out, sizeof out - 1);
  if (len > 0){ out[len] = 0; return string(out); }
#endif
  return string(g_argc > 0 ? g_argv[0] : "");
}
static tsv host_exit(tsv* a, int n){ fflush(stdout); fflush(stderr); exit(n > 0 && ts_is_num(a[0]) ? (int)ts_to_num(a[0]) : 0); }
static tsv host_isatty(tsv* a, int n){ return ts_bool(isatty((int)ts_to_num(arg(a, n, 0)))); }
static tsv host_pid(tsv* a, int n){ (void)a; (void)n; return ts_num((double)getpid()); }
static tsv host_ppid(tsv* a, int n){ (void)a; (void)n; return ts_num((double)getppid()); }
static tsv host_hrtime(tsv* a, int n){
  (void)a; (void)n;
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  tsv out = ts_new_array(0); ts_gc_root(&out);
  ts_array_push(out, ts_num((double)t.tv_sec)); ts_array_push(out, ts_num((double)t.tv_nsec));
  ts_gc_unroot(1);
  return out;
}
static tsv host_now(tsv* a, int n){
  (void)a; (void)n;
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return ts_num((double)(t.tv_sec - g_start.tv_sec) * 1e3 + (double)(t.tv_nsec - g_start.tv_nsec) / 1e6);
}
static tsv host_rss(tsv* a, int n){
  (void)a; (void)n;
  struct rusage r; getrusage(RUSAGE_SELF, &r);
#ifdef __APPLE__
  return ts_num((double)r.ru_maxrss);
#else
  return ts_num((double)r.ru_maxrss * 1024);
#endif
}
static tsv host_cpu_usage(tsv* a, int n){
  (void)a; (void)n;
  struct rusage r; getrusage(RUSAGE_SELF, &r);
  tsv out = ts_new_array(0); ts_gc_root(&out);
  ts_array_push(out, ts_num((double)r.ru_utime.tv_sec * 1e6 + (double)r.ru_utime.tv_usec));
  ts_array_push(out, ts_num((double)r.ru_stime.tv_sec * 1e6 + (double)r.ru_stime.tv_usec));
  ts_gc_unroot(1);
  return out;
}
static tsv host_totalmem(tsv* a, int n){
  (void)a; (void)n;
#ifdef __APPLE__
  uint64_t mem = 0; size_t size = sizeof mem;
  if (sysctlbyname("hw.memsize", &mem, &size, NULL, 0) == 0) return ts_num((double)mem);
  return ts_num(0);
#else
  long pages = sysconf(_SC_PHYS_PAGES), page = sysconf(_SC_PAGE_SIZE);
  return ts_num((double)pages * (double)page);
#endif
}
/* the length in bytes of a string's UTF-8 form (lone surrogates 3 bytes, as U+FFFD) */
static tsv host_utf8_length(tsv* a, int n){
  tsv s = arg(a, n, 0);
  if (!ts_is_str(s)) return ts_num(0);
  ts_strview v = ts_str_view_typed(s);
  /* ASCII: one byte per unit; 8-bit storage: two bytes for each unit past
     0x7F; UTF-16 storage: the general walk */
  if (v.flags & TS_STR_FLAG_ASCII) return ts_num((double)v.len);
  if (v.data && !(v.flags & TS_STR_FLAG_UTF16)){
    const unsigned char* b = (const unsigned char*)v.data;
    uint64_t high = 0;
    for (uint32_t i = 0; i < v.len; i++) high += b[i] >> 7;
    return ts_num((double)v.len + (double)high);
  }
  double total = 0;
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
/* writeUtf16le(text, view, offset): the string's code units, little-endian,
   whole units while they fit (Buffer#write(text, 'utf16le')) */
static tsv host_write_utf16le(tsv* a, int n){
  tsv s = arg(a, n, 0), view = arg(a, n, 1);
  if (!ts_is_str(s) || !ts_is_typed_array(view)) ts_throw_type_error_msg("writeUtf16le: a string and a Uint8Array");
  ts_typedarray* t = (ts_typedarray*)ts_ptr(view);
  double off = ts_to_num(arg(a, n, 2));
  if (!(off >= 0) || off > t->length) ts_throw_range_error_msg("writeUtf16le: offset out of range");
  ts_strview v = ts_str_view_typed(s);
  uint32_t room = (t->length - (uint32_t)off) / 2u;
  uint32_t units = v.len < room ? v.len : room;
  uint8_t* out = t->data + (size_t)off;
  for (uint32_t i = 0; i < units; i++){
    uint16_t cu = ts_str_cu_at_view(v, i);
    out[2 * i] = (uint8_t)(cu & 0xFFu); out[2 * i + 1] = (uint8_t)(cu >> 8);
  }
  return ts_num((double)units * 2);
}
static void method(tsv host, const char* name, ts_code code, int arity){
  ts_gc_root(&host); tsv fn = ts_make_fn_t(code, NULL, 0, 0); ts_gc_root(&fn);
  ts_set_fn_meta(fn, (uint32_t)arity, name); ts_set_cstr(host, name, fn); ts_gc_unroot(2);
}
void garnet_tsc_ts_host_init(int argc, char** argv){
  g_argc = argc; g_argv = argv;
  clock_gettime(CLOCK_MONOTONIC, &g_start);
  tsv host = ts_new_object(); ts_gc_root(&host);
  method(host, "readFile", host_read_file, 1);
  method(host, "writeFile", host_write_file, 2);
  method(host, "writeFd", host_write_fd, 4);
  method(host, "readFd", host_read_fd, 4);
  method(host, "stat", host_stat, 2);
  method(host, "readdir", host_readdir, 1);
  method(host, "mkdir", host_mkdir, 2);
  method(host, "realpath", host_realpath, 1);
  method(host, "unlink", host_unlink, 1);
  method(host, "utimes", host_utimes, 3);
  method(host, "lastError", host_last_error, 0);
  method(host, "cwd", host_cwd, 0);
  method(host, "env", host_env, 0);
  method(host, "argv", host_argv, 0);
  method(host, "execPath", host_exec_path, 0);
  method(host, "exit", host_exit, 1);
  method(host, "isatty", host_isatty, 1);
  method(host, "pid", host_pid, 0);
  method(host, "ppid", host_ppid, 0);
  method(host, "hrtime", host_hrtime, 0);
  method(host, "now", host_now, 0);
  method(host, "rss", host_rss, 0);
  method(host, "cpuUsage", host_cpu_usage, 0);
  method(host, "totalmem", host_totalmem, 0);
  method(host, "utf8Length", host_utf8_length, 1);
  method(host, "writeUtf16le", host_write_utf16le, 3);
#ifdef __APPLE__
  ts_set_cstr(host, "platform", string("darwin"));
#else
  ts_set_cstr(host, "platform", string("linux"));
#endif
  ts_global_set("__garnetHost", host);
  ts_gc_unroot(1);
}
