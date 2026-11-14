// JNI 桥：在 Android 上把 nodejs-mobile（digidem v24.20.0 的 libnode.so）启动起来，跑网关 bundle。
//
// 关键点（对应 digidem EMBEDDING.md）：
//  - node::Start 阻塞，必须在后台线程调用，否则会卡死调用线程；这里 detach 一个 std::thread。
//  - 所有 node 读取一次的环境变量（TMPDIR / NODE_OPTIONS / GATEWAY_* / NODE_COMPILE_CACHE 等）
//    必须在 node::Start 之前 setenv；digidem 的 credentials patch 已让 Android app 进程能读到这些变量。
//  - Android 没有 /tmp，必须设 TMPDIR=getCacheDir；HOME 设到应用目录，否则 os.homedir()/os.tmpdir() 出错。
//  - 编译：用 NDK 编出 libgatewaynode.so，链接 digidem 的 libnode（见 CMakeLists.txt），并包含 digidem
//    发布包里的 include/node 头文件。

#include <jni.h>
#include <string>
#include <vector>
#include <thread>
#include <cstdlib>
#include "node.h"  // digidem nodejs-mobile 的 include/node/node.h

static void setEnv(const char* k, const std::string& v) {
  setenv(k, v.c_str(), 1);
}

extern "C" JNIEXPORT void JNICALL
Java_com_xiaoxiong_assistant_gateway_GatewayNodeService_nativeStartNode(
    JNIEnv* env, jobject /*thiz*/, jstring homeDir, jstring cacheDir, jobjectArray nodeArgs) {
  const char* homeC = env->GetStringUTFChars(homeDir, nullptr);
  const char* cacheC = env->GetStringUTFChars(cacheDir, nullptr);
  std::string home(homeC);
  std::string cache(cacheC);
  env->ReleaseStringUTFChars(homeDir, homeC);
  env->ReleaseStringUTFChars(cacheDir, cacheC);

  // ---- 启动 node 前设环境（读取一次，顺序敏感）----
  setEnv("GATEWAY_HOME", home);
  setEnv("TMPDIR", cache);                 // Android 无 /tmp，必须设
  setEnv("HOME", home);                    // os.homedir() 才可用
  setEnv("GATEWAY_MODE", "embedded");
  setEnv("DOCS_ENABLED", "false");
  // 固定端口：客户端兜底默认地址即 ws://127.0.0.1:8787/ws，无需依赖 plus.io 读端口文件
  // （真机实测 plus.io 各 root 均未映射到 getFilesDir()，动态端口+文件回传链路在 JS 侧断掉）。
  setEnv("GATEWAY_PORT", "8787");
  setEnv("GATEWAY_PORT_FILE", home + "/.gateway_port");
  setEnv("NODE_COMPILE_CACHE", cache + "/node-cache");  // V8 代码缓存，加速冷启
  // 后台运行时不能按整机 RAM 定 old-space，用百分比上限避免触发 cgroup 杀进程
  setEnv("NODE_OPTIONS", "--max-old-space-size-percentage=50 --enable-source-maps");

  // 工作目录切到 home，相对路径解析才有基准
  chdir(home.c_str());

  // ---- 拼 argv ----
  int argc = env->GetArrayLength(nodeArgs);
  std::vector<std::string> keep;
  std::vector<char*> argv(argc);
  for (int i = 0; i < argc; i++) {
    jstring s = (jstring)env->GetObjectArrayElement(nodeArgs, i);
    const char* c = env->GetStringUTFChars(s, nullptr);
    keep.emplace_back(c);
    env->ReleaseStringUTFChars(s, c);
    argv[i] = const_cast<char*>(keep.back().c_str());
  }

  // node::Start 阻塞 → 放到后台线程，Service 主线程立即返回
  std::thread([](int ac, std::vector<char*> av) {
    node::Start(ac, av.data());
  }, argc, std::move(argv)).detach();
}
