// flock-binding.cc — thin N-API addon exposing flock(2) to Node.
//
// Canonical artifact for NOVA Phase 5 Rev 4.8 (design §10, lines 800-830):
// the alert dispatcher imports { flockExNb, flockUn } from './flock-binding.mjs'
// and this file is the native implementation behind that loader.
//
//   flockExNb(fd) — flock(fd, LOCK_EX | LOCK_NB)
//       true  on success; false when the lock is held (EWOULDBLOCK/EAGAIN);
//       throws on any other failure (e.g. EBADF on a bad fd).
//   flockUn(fd)   — flock(fd, LOCK_UN); throws on failure.
//
// Build: see build-flock-binding.sh in this directory. The .node produced
// here is a build product; this .cc is the canonical source.
#include <node_api.h>
#include <sys/file.h>
#include <errno.h>
#include <cstdio>
#include <string.h>

// Throw a JS Error carrying the errno as `code` (e.g. 'EBADF') and the
// strerror text in the message, then return NULL (pending exception).
static napi_value throwErrno(napi_env env, int errnum, const char* fn) {
  char msg[256];
  snprintf(msg, sizeof(msg), "%s failed: %s", fn, strerror(errnum));
  napi_value message, code, error;
  napi_create_string_utf8(env, msg, NAPI_AUTO_LENGTH, &message);
  napi_create_string_utf8(env, strerror(errnum), NAPI_AUTO_LENGTH, &code);
  // errno names: map the few we can plausibly see; fall back to the number.
  const char* name = nullptr;
  switch (errnum) {
    case EBADF: name = "EBADF"; break;
    case EINVAL: name = "EINVAL"; break;
    case EWOULDBLOCK: name = "EWOULDBLOCK"; break;
    case EINTR: name = "EINTR"; break;
    case ENOLCK: name = "ENOLCK"; break;
    case EOPNOTSUPP: name = "EOPNOTSUPP"; break;
    default: break;
  }
  napi_value codeValue;
  if (name) {
    napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &codeValue);
  } else {
    char num[32];
    snprintf(num, sizeof(num), "ERRNO_%d", errnum);
    napi_create_string_utf8(env, num, NAPI_AUTO_LENGTH, &codeValue);
  }
  napi_create_error(env, codeValue, message, &error);
  // Attach the numeric errno as well, for diagnostics.
  napi_value errnoNum;
  napi_create_int32(env, errnum, &errnoNum);
  napi_value errnoKey;
  napi_create_string_utf8(env, "errno", NAPI_AUTO_LENGTH, &errnoKey);
  napi_set_property(env, error, errnoKey, errnoNum);
  (void)code; // code string is folded into the Error `code` argument above.
  napi_throw(env, error);
  return nullptr;
}

// Validate a single integer fd argument; throws TypeError/RangeError on bad input.
static bool getFd(napi_env env, napi_callback_info info, int* outFd) {
  size_t argc = 1;
  napi_value argv[1];
  napi_status s = napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (s != napi_ok) return false;
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "flock: fd argument is required");
    return false;
  }
  napi_valuetype t;
  if (napi_typeof(env, argv[0], &t) != napi_ok || t != napi_number) {
    napi_throw_type_error(env, nullptr, "flock: fd must be a number");
    return false;
  }
  double d;
  if (napi_get_value_double(env, argv[0], &d) != napi_ok) return false;
  if (d != (double)(int)d || d < 0) {
    napi_throw_range_error(env, nullptr, "flock: fd must be a non-negative integer");
    return false;
  }
  *outFd = (int)d;
  return true;
}

static napi_value flockExNb(napi_env env, napi_callback_info info) {
  int fd;
  if (!getFd(env, info, &fd)) return nullptr;
  int rc;
  do {
    rc = flock(fd, LOCK_EX | LOCK_NB);
  } while (rc != 0 && errno == EINTR);
  if (rc == 0) {
    napi_value result;
    napi_get_boolean(env, true, &result);
    return result;
  }
  int err = errno;
  if (err == EWOULDBLOCK) { // EWOULDBLOCK == EAGAIN on Linux; lock held.
    napi_value result;
    napi_get_boolean(env, false, &result);
    return result;
  }
  return throwErrno(env, err, "flockExNb");
}

static napi_value flockUn(napi_env env, napi_callback_info info) {
  int fd;
  if (!getFd(env, info, &fd)) return nullptr;
  int rc;
  do {
    rc = flock(fd, LOCK_UN);
  } while (rc != 0 && errno == EINTR);
  if (rc == 0) {
    napi_value result;
    napi_get_boolean(env, true, &result);
    return result;
  }
  return throwErrno(env, errno, "flockUn");
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
    {"flockExNb", nullptr, flockExNb, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"flockUn", nullptr, flockUn, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, desc);
  return exports;
}

#ifndef NODE_GYP_MODULE_NAME
#define NODE_GYP_MODULE_NAME flock_binding
#endif
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
