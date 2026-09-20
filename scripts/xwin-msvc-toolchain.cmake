# CMake toolchain for cross-compiling to x86_64-pc-windows-msvc from Linux
# using clang-cl + xwin (MSVC CRT + Windows SDK installed in /opt/xwin).
#
# Why this exists: the `cmake` crate (used by audiopus_sys) drives CMake for
# C crates when cross-compiling to MSVC. On a Linux box there is no Visual
# Studio, so cmake-rs falls back to CMAKE_GENERATOR=Ninja (set in
# .github/workflows/release.yml). CMake's compiler detection wants the *debug*
# CRT (/MDd -> msvcrtd.lib); xwin ships the release CRT only, so this
# toolchain forces /MD (see below).
#
# Also wires up the xwin include paths (-imsvc) and import-lib paths
# (-libpath) so CMake's try_compile can compile AND link (it links via
# lld-link directly, bypassing the clang-cl driver, so flags must reach the
# link line as -libpath, and lld-link also picks up the LIB env var).
#
# Referenced via CMAKE_TOOLCHAIN_FILE (repo-relative path from the runner).

if(NOT DEFINED CMAKE_SYSTEM_NAME)
  set(CMAKE_SYSTEM_NAME Windows)
endif()
set(CMAKE_SYSTEM_PROCESSOR AMD64)

set(CMAKE_C_COMPILER clang-cl)
set(CMAKE_CXX_COMPILER clang-cl)
set(CMAKE_C_COMPILER_TARGET x86_64-pc-windows-msvc)
set(CMAKE_CXX_COMPILER_TARGET x86_64-pc-windows-msvc)
set(CMAKE_RC_COMPILER llvm-rc)

# xwin ships release CRT only — /MD everywhere, never /MDd. Two mechanisms:
# 1) For crates with a modern cmake_minimum_required: set CMP0091 NEW so
#    CMAKE_MSVC_RUNTIME_LIBRARY below is honored.
# 2) For crates that pin an old cmake_minimum_required (audiopus_sys uses
#    3.1, which resets CMP0091 to OLD and ignores the runtime-library
#    variable): override the DEBUG config flags, which CMake's try_compile
#    uses for compiler detection, to /MD. Windows-MSVC.cmake seeds these as
#    non-FORCE cache entries, so our FORCE value wins.
cmake_policy(SET CMP0091 NEW)
set(CMAKE_MSVC_RUNTIME_LIBRARY MultiThreadedDLL)
set(CMAKE_C_FLAGS_DEBUG "/MD" CACHE STRING "" FORCE)
set(CMAKE_CXX_FLAGS_DEBUG "/MD" CACHE STRING "" FORCE)

set(XWIN_ROOT "/opt/xwin")
set(XWIN_INCLUDE_DIRS
  "${XWIN_ROOT}/crt/include"
  "${XWIN_ROOT}/sdk/include/ucrt"
  "${XWIN_ROOT}/sdk/include/um"
  "${XWIN_ROOT}/sdk/include/shared")
set(XWIN_LIB_DIRS
  "${XWIN_ROOT}/crt/lib/x86_64"
  "${XWIN_ROOT}/sdk/lib/um/x86_64"
  "${XWIN_ROOT}/sdk/lib/ucrt/x86_64")

set(CMAKE_C_FLAGS_INIT "")
set(CMAKE_CXX_FLAGS_INIT "")
foreach(dir ${XWIN_INCLUDE_DIRS})
  string(APPEND CMAKE_C_FLAGS_INIT " -imsvc ${dir}")
  string(APPEND CMAKE_CXX_FLAGS_INIT " -imsvc ${dir}")
endforeach()

foreach(kind EXE SHARED MODULE)
  set(CMAKE_${kind}_LINKER_FLAGS_INIT "")
  foreach(dir ${XWIN_LIB_DIRS})
    string(APPEND CMAKE_${kind}_LINKER_FLAGS_INIT " -libpath:${dir}")
  endforeach()
endforeach()
