/* Synchronous TypeScript System host for the native compiler benchmark.
   Compiler algorithms are supplied by the unmodified upstream TS source. */
#include "ts_rt.h"
#include "host.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

static tsv arg(tsv* a, int n, int i){ return i < n ? a[i] : TS_UNDEFINED; }
static char* text(tsv value){
  uint32_t length;
  char* result = ts_string_utf8_copy(value, &length);
  if (memchr(result, 0, length)) { free(result); ts_throw_type_error_msg("NUL in native host path"); }
  return result;
}
static tsv string(const char* value){ return ts_new_string(value, (uint32_t)strlen(value)); }
static tsv host_write(tsv* a, int n){
  uint32_t length; char* bytes = ts_string_utf8_copy(arg(a,n,0), &length);
  if (fwrite(bytes, 1, length, stdout) != length) { free(bytes); ts_throw_type_error_msg("stdout write failed"); }
  free(bytes); return TS_UNDEFINED;
}
/* open / fstat / read, as Node's readFileSync: the stdio size probe
   (fseek to the end, ftell, rewind) cost more than the reads. */
static tsv host_read(tsv* a, int n){
  char* path = text(arg(a,n,0)); int fd = open(path, O_RDONLY); free(path);
  if (fd < 0) return TS_UNDEFINED;
  struct stat st;
  if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size < 0 || (unsigned long long)st.st_size > UINT32_MAX) { close(fd); return TS_UNDEFINED; }
  size_t size = (size_t)st.st_size;
  unsigned char* bytes = malloc(size + 1);
  size_t length = 0; int failed = 0;
  while (length < size){
    ssize_t got = read(fd, bytes + length, size - length);
    if (got < 0){ if (errno == EINTR) continue; failed = 1; break; }
    if (got == 0) break;
    length += (size_t)got;
  }
  close(fd);
  if (failed) { free(bytes); return TS_UNDEFINED; }
  tsv result;
  if (length >= 2 && ((bytes[0] == 0xff && bytes[1] == 0xfe) || (bytes[0] == 0xfe && bytes[1] == 0xff))) {
    uint32_t count = (uint32_t)(length - 2) / 2;
    uint32_t* units = malloc(sizeof(uint32_t) * (count ? count : 1));
    int little = bytes[0] == 0xff;
    for (uint32_t i = 0; i < count; i++) units[i] = little
      ? bytes[2+i*2] | ((uint32_t)bytes[3+i*2] << 8)
      : ((uint32_t)bytes[2+i*2] << 8) | bytes[3+i*2];
    result = ts_string_from_codepoints(units, count); free(units);
  } else {
    size_t start = length >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf ? 3 : 0;
    result = ts_new_string((char*)bytes + start, (uint32_t)(length - start));
  }
  free(bytes); return result;
}
static tsv host_write_file(tsv* a, int n){
  char* path = text(arg(a,n,0)); FILE* file = fopen(path,"wb"); free(path);
  if (!file) ts_throw_type_error_msg("Cannot open native compiler output");
  uint32_t length; char* bytes = ts_string_utf8_copy(arg(a,n,1),&length);
  if (ts_truthy(arg(a,n,2))) fwrite("\xef\xbb\xbf",1,3,file);
  int failed = fwrite(bytes,1,length,file) != length; free(bytes);
  failed |= fclose(file) != 0;
  if (failed) ts_throw_type_error_msg("Native compiler output write failed");
  return TS_UNDEFINED;
}
static int stat_path(tsv value, struct stat* info){ char* path=text(value); int rc=stat(path,info); free(path); return rc; }
static tsv host_file_exists(tsv* a,int n){ struct stat st; return ts_bool(!stat_path(arg(a,n,0),&st) && S_ISREG(st.st_mode)); }
static tsv host_directory_exists(tsv* a,int n){ struct stat st; return ts_bool(!stat_path(arg(a,n,0),&st) && S_ISDIR(st.st_mode)); }
static tsv host_file_size(tsv* a,int n){ struct stat st; return ts_num(!stat_path(arg(a,n,0),&st) ? (double)st.st_size : 0); }
static tsv host_mkdir(tsv* a,int n){
  char* path=text(arg(a,n,0)); int rc=mkdir(path,0777); int saved=errno; free(path);
  if (rc && saved != EEXIST) ts_throw_type_error_msg("Cannot create native compiler output directory");
  return TS_UNDEFINED;
}
static tsv host_cwd(tsv* a,int n){ (void)a;(void)n; char path[PATH_MAX]; return getcwd(path,sizeof path)?string(path):TS_UNDEFINED; }
static tsv host_realpath(tsv* a,int n){
  char* path=text(arg(a,n,0)); char resolved[PATH_MAX];
  tsv result=realpath(path,resolved)?string(resolved):string(path); free(path); return result;
}
static tsv host_env(tsv* a,int n){ char* key=text(arg(a,n,0)); const char* value=getenv(key); free(key); return string(value?value:""); }
static tsv host_executing_file(tsv* a,int n){
  (void)a;(void)n; const char* dir=getenv("GARNET_TSC_LIB_DIR");
  if (!dir) ts_throw_type_error_msg("GARNET_TSC_LIB_DIR is required");
  size_t length=strlen(dir)+8; char* path=malloc(length); snprintf(path,length,"%s/tsc.js",dir);
  tsv result=string(path); free(path); return result;
}
static tsv host_exit(tsv* a,int n){ fflush(stdout); exit(n && ts_is_num(a[0]) ? (int)ts_to_num(a[0]) : 0); }
static tsv host_modified(tsv* a,int n){
  struct stat st; if (stat_path(arg(a,n,0),&st)) return TS_UNDEFINED;
#ifdef __APPLE__
  return ts_num((double)st.st_mtimespec.tv_sec*1000 + st.st_mtimespec.tv_nsec/1e6);
#else
  return ts_num((double)st.st_mtim.tv_sec*1000 + st.st_mtim.tv_nsec/1e6);
#endif
}
static tsv host_set_modified(tsv* a,int n){
  char* path=text(arg(a,n,0)); double ms=ts_to_num(arg(a,n,1));
  struct timespec times[2]={{.tv_nsec=UTIME_OMIT},{.tv_sec=(time_t)floor(ms/1000),.tv_nsec=(long)(fmod(ms,1000)*1e6)}};
  int rc=utimensat(AT_FDCWD,path,times,0); free(path);
  if (rc) ts_throw_type_error_msg("Cannot set file modification time");
  return TS_UNDEFINED;
}
static tsv host_delete(tsv* a,int n){ char* path=text(arg(a,n,0)); int rc=unlink(path); int saved=errno; free(path); if(rc && saved!=ENOENT)ts_throw_type_error_msg("Cannot delete compiler output"); return TS_UNDEFINED; }
static tsv host_memory(tsv* a,int n){ (void)a;(void)n; struct rusage r; getrusage(RUSAGE_SELF,&r);
#ifdef __APPLE__
  return ts_num((double)r.ru_maxrss);
#else
  return ts_num((double)r.ru_maxrss*1024);
#endif
}
static tsv host_entries(tsv* a,int n){
  char* path=text(arg(a,n,0)); DIR* dir=opendir(path);
  tsv files=ts_new_array(0); ts_gc_root(&files);
  tsv dirs=ts_new_array(0); ts_gc_root(&dirs);
  if(dir){
    struct dirent* entry;
    while((entry=readdir(dir))){
      if(!strcmp(entry->d_name,".") || !strcmp(entry->d_name,".."))continue;
      size_t size=strlen(path)+strlen(entry->d_name)+2; char* full=malloc(size);
      snprintf(full,size,"%s/%s",path,entry->d_name); struct stat st; int rc=stat(full,&st); free(full);
      if(!rc && (S_ISDIR(st.st_mode)||S_ISREG(st.st_mode))){
        tsv name=string(entry->d_name);
        ts_array_push(S_ISDIR(st.st_mode)?dirs:files,name);
      }
    }
    closedir(dir);
  }
  free(path);
  tsv result=ts_new_object(); ts_gc_root(&result);
  ts_set_cstr(result,"files",files); ts_set_cstr(result,"directories",dirs);
  ts_gc_unroot(3); return result;
}
static void method(tsv host,const char* name,ts_code code,int arity){
  ts_gc_root(&host); tsv fn=ts_make_fn_t(code,NULL,0,0); ts_gc_root(&fn);
  ts_set_fn_meta(fn,(uint32_t)arity,name); ts_set_cstr(host,name,fn); ts_gc_unroot(2);
}
void garnet_native_system_init(int argc,char** argv){
  tsv host=ts_new_object(); ts_gc_root(&host);
  tsv args=ts_new_array(0); ts_gc_root(&args);
  for(int i=1;i<argc;i++)ts_array_push(args,string(argv[i]));
  ts_set_cstr(host,"args",args); ts_set_cstr(host,"newLine",string("\n"));
#ifdef __APPLE__
  ts_set_cstr(host,"useCaseSensitiveFileNames",ts_bool(0));
#else
  ts_set_cstr(host,"useCaseSensitiveFileNames",ts_bool(1));
#endif
  method(host,"write",host_write,1); method(host,"readFile",host_read,1); method(host,"writeFile",host_write_file,2);
  method(host,"fileExists",host_file_exists,1); method(host,"directoryExists",host_directory_exists,1);
  method(host,"getFileSize",host_file_size,1); method(host,"createDirectory",host_mkdir,1);
  method(host,"getCurrentDirectory",host_cwd,0); method(host,"realpath",host_realpath,1);
  method(host,"getEnvironmentVariable",host_env,1); method(host,"getExecutingFilePath",host_executing_file,0);
  method(host,"exit",host_exit,1); method(host,"modifiedTime",host_modified,1);
  method(host,"setModifiedTimeMs",host_set_modified,2); method(host,"deleteFile",host_delete,1);
  method(host,"getMemoryUsage",host_memory,0); method(host,"getAccessibleFileSystemEntries",host_entries,1);
  ts_global_set("__garnetSystem",host); ts_gc_unroot(2);
}
