# Windows 原生助手（GAP-008）：由 scripts/build-native-win.cjs 调用，产物复制到 native/bin/mt-*.exe
cmake_minimum_required(VERSION 3.20)
project(mytypeless_native_win C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# 静态链接 C/C++ 运行库：产物只依赖系统 DLL，不需要另装 VC++ 运行库
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
add_compile_options(/utf-8)
add_compile_definitions(UNICODE _UNICODE)

foreach(helper mt-text mt-focus mt-inject mt-hotkey mt-audiotap)
  string(REPLACE "mt-" "" stem ${helper})
  add_executable(${helper} ${stem}-helper.cpp)
  target_compile_options(${helper} PRIVATE /W4 /permissive-)
endforeach()

# 会议声纹 / 内置中文识别：与 macOS 同一份 native/diarize-helper.c，静态链接 sherpa-onnx 的 Windows 预编译库
if(SHERPA_DIR)
  add_executable(mt-diarize ${CMAKE_CURRENT_SOURCE_DIR}/../diarize-helper.c)
  target_include_directories(mt-diarize PRIVATE ${SHERPA_DIR}/include)
  target_compile_definitions(mt-diarize PRIVATE _CRT_SECURE_NO_WARNINGS)
  file(GLOB SHERPA_LIBS ${SHERPA_DIR}/lib/*.lib)
  target_link_libraries(mt-diarize PRIVATE ${SHERPA_LIBS})
endif()
