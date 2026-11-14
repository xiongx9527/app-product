#!/usr/bin/env bash
# 免费 Personal Team 的 provisioning profile 只有 7 天，且按设备 UDID 白名单签发。
# 本脚本把有效期再续 7 天，并装机到「当前 USB 在线的真机」。
#
# 为什么仍要逐台 xcodebuild（不能一次通用包打天下）：
#   -destination 'generic/platform=iOS' 的通用编译不会把新设备 UDID 注册进免费团队，
#   实测通用编译后 profile 的 ProvisionedDevices 仍只有已注册设备；新设备装机就会报
#   0xe8008015 "A valid provisioning profile for this executable was not found"。
#   只有用具体设备作 destination + -allowProvisioningUpdates，Xcode 才会注册该设备并刷新 profile。
#   因此每台设备必须单独编译一次；且每台编译成功后立刻用「当次产物」给该台装机
#   （后续设备编译会覆盖 DerivedData 里同一路径的 .app 与 embedded.mobileprovision）。
#
# 设备范围：只处理 ios-deploy -c 列出的「当前 USB 在线」设备。不在线的设备根本不出现，
#   静默忽略、不报错、不算失败（只有一根线时只处理插着的那台）。绝不按某个 UDID 去探测
#   设备是否存在——那会在离线设备上挂住等待。
#
# 容错：每台独立处理；设备侧可自行解决的状态（离线 / 待信任 / iOS16 开发者模式）都只是
#   「跳过或待处理」，不算错误、不影响退出码；最后统一汇总，脚本正常结束。
#
# 用法：./reprovision.sh
#   IOS_TEAM / IOS_DEPLOY / IPA_OUT 可用环境变量覆盖；其余从 build.local 与工程读取。
# 依赖：Xcode 命令行工具、brew 版 ios-deploy（/usr/local/bin，别用被 PATH 遮蔽的 npm 版）。

# 不用 set -e：逐台处理需要自己判断成败并继续；-u 保留以捕获变量拼写错误。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/build.local"

# build.local 里 IOS_SDK 常写成 ~/xxx，source 后不会展开 ~，这里手动展开
SDK="${IOS_SDK/#\~/$HOME}"
WORKSPACE="$SDK/HBuilder-Hello.xcworkspace"
PBX="$SDK/HBuilder-Hello.xcodeproj/project.pbxproj"
SCHEME="HBuilder"
CONFIG="Debug"
IOS_DEPLOY="${IOS_DEPLOY:-/usr/local/bin/ios-deploy}"
IPA_OUT="${IPA_OUT:-$HOME/Downloads/HBuilder-signed.ipa}"

if [ ! -d "$WORKSPACE" ]; then echo "找不到 workspace: $WORKSPACE"; exit 1; fi
if [ ! -x "$IOS_DEPLOY" ]; then echo "找不到 brew 版 ios-deploy: $IOS_DEPLOY"; exit 1; fi

# Team ID 从工程里读，避免和 build.local 两处维护；工程已写入 DEVELOPMENT_TEAM
TEAM="${IOS_TEAM:-$(grep -m1 'DEVELOPMENT_TEAM = ' "$PBX" | sed -E 's/.*DEVELOPMENT_TEAM = ([A-Z0-9]+);.*/\1/')}"
if [ -z "$TEAM" ]; then echo "读不到 DEVELOPMENT_TEAM，请设 IOS_TEAM"; exit 1; fi
echo "Team: $TEAM"

# 1) 只发现「当前 USB 在线」的真机。ios-deploy -c 只列连上的设备（每个一行 "Found <UDID> ..."），
#    离线设备不会出现 → 天然忽略、不报错；自带 5s 超时，不会挂住。
#    用 while read 而非 mapfile：macOS 自带 bash 3.2 没有 mapfile。
UDIDS=()
while IFS= read -r udid; do
  [ -n "$udid" ] && UDIDS+=("$udid")
done < <(
  "$IOS_DEPLOY" -c --no-wifi -t 5 2>/dev/null \
    | grep -oE 'Found [0-9a-f]{40}' | awk '{print $2}' | sort -u
)
if [ "${#UDIDS[@]}" -eq 0 ]; then
  echo "当前没有在线的 USB 真机，跳过（不视为错误）"
  exit 0
fi
echo "在线 ${#UDIDS[@]} 台: ${UDIDS[*]}"
echo

# 2) 产物路径（-showBuildSettings 取，不硬编码 DerivedData；每台编译覆盖同一路径）
READ=$(cd "$SDK" && xcodebuild -workspace "$WORKSPACE" -scheme "$SCHEME" \
  -configuration "$CONFIG" -showBuildSettings 2>/dev/null)
DIR=$(printf '%s\n' "$READ" | awk -F'= ' '/ BUILT_PRODUCTS_DIR =/{print $2}' | head -1)
NAME=$(printf '%s\n' "$READ" | awk -F'= ' '/ FULL_PRODUCT_NAME =/{print $2}' | head -1)
APP="$DIR/$NAME"

# 3) 逐台：编译注册 → 装机。每台独立，设备侧状态只记录、不报错、不阻断。
OK_LIST=()
NEED_TRUST_LIST=()
SKIP_LIST=()
LAST_GOOD_APP=""

for udid in "${UDIDS[@]}"; do
  echo "==== 设备 $udid ===="
  BUILD_LOG="/tmp/reprovision-build-$udid.log"

  # 3a) 用该设备作 destination 触发 Xcode 注册 UDID + 刷新 7 天 profile
  echo "  [1/2] 编译并注册设备"
  if (cd "$SDK" && xcodebuild \
      -workspace "$WORKSPACE" -scheme "$SCHEME" -configuration "$CONFIG" \
      -destination "platform=iOS,id=$udid" -allowProvisioningUpdates \
      DEVELOPMENT_TEAM="$TEAM" \
      > "$BUILD_LOG" 2>&1); then
    echo "        BUILD SUCCEEDED"
  else
    # 设备不在线/不可用：静默跳过，不算失败、不报错
    if grep -qiE 'Unable to find a device|Ineligible destinations|device.*not connected|not available' "$BUILD_LOG"; then
      echo "        设备已离线或不可用，跳过"
      SKIP_LIST+=("$udid : 离线/不可用")
      echo
      continue
    fi
    reason="编译失败"
    if grep -q 'enable Developer Mode' "$BUILD_LOG"; then
      reason="待处理：iOS 16+ 未开「开发者模式」"
      echo "        $reason"
      echo "        → 设备端：设置 → 隐私与安全性 → 开发者模式 → 打开 → 重启 → 解锁确认"
      echo "          （只能手动完成，开完再跑一次本脚本）"
    elif grep -q 'not installed\|Platform Not Installed' "$BUILD_LOG"; then
      reason="待处理：Xcode 缺该 iOS 版本的 DeviceSupport"
      echo "        $reason"
    else
      echo "        $reason，详见 $BUILD_LOG"
      grep -iE 'error:|No profiles|no identities' "$BUILD_LOG" | tail -5
    fi
    SKIP_LIST+=("$udid : $reason")
    echo
    continue
  fi

  if [ ! -d "$APP" ]; then
    echo "        找不到产物 .app: $APP，跳过"
    SKIP_LIST+=("$udid : 产物缺失")
    echo
    continue
  fi
  LAST_GOOD_APP="$APP"

  # 3b) 用当次产物给该台装机
  echo "  [2/2] 装机"
  INSTALL_LOG="/tmp/reprovision-install-$udid.log"
  "$IOS_DEPLOY" --id "$udid" --bundle "$APP" --no-wifi --justlaunch > "$INSTALL_LOG" 2>&1
  # justlaunch 的 safequit 常返回非 0，以日志为准，且必须区分「装上了」与「装上了但启动被拦」
  if grep -q 'Installed package' "$INSTALL_LOG"; then
    if grep -qiE 'Cannot launch|not explicitly trusted|invalid code signature' "$INSTALL_LOG"; then
      echo "        已安装，待设备端信任后即可打开"
      echo "        → 设置 → 通用 → VPN 与设备管理 → 点 Apple Development 证书 → 信任"
      NEED_TRUST_LIST+=("$udid")
    else
      echo "        装机完成（手动点图标启动即可常驻）"
      OK_LIST+=("$udid")
    fi
  else
    reason="待处理：装机未完成"
    if grep -qi 'valid provisioning profile.*not found\|0xe8008015' "$INSTALL_LOG"; then
      reason="待处理：profile 未包含该设备"
    elif grep -qi 'Developer Mode' "$INSTALL_LOG"; then
      reason="待处理：iOS 16+ 未开开发者模式"
    fi
    echo "        $reason，详见 $INSTALL_LOG"
    grep -iE 'error|0xe8008015|not found|not explicitly|Unable' "$INSTALL_LOG" | tail -4
    SKIP_LIST+=("$udid : $reason")
  fi
  echo
done

# 4) 汇总（设备侧状态一律不算错误）
echo "================ 汇总 ================"
echo "装机完成 ${#OK_LIST[@]} 台:"
for x in "${OK_LIST[@]:-}"; do [ -n "$x" ] && echo "  ✓ $x"; done
echo "已安装·待信任 ${#NEED_TRUST_LIST[@]} 台（设备端点一次「信任」即可用，不需重跑）:"
for x in "${NEED_TRUST_LIST[@]:-}"; do [ -n "$x" ] && echo "  · $x"; done
echo "跳过 ${#SKIP_LIST[@]} 台（离线/待处理，均不算错误）:"
for x in "${SKIP_LIST[@]:-}"; do [ -n "$x" ] && echo "  - $x"; done

# 5) 用最后一次编译成功的产物重打 IPA（profile 含所有已成功注册的设备）
if [ -n "$LAST_GOOD_APP" ] && [ -d "$LAST_GOOD_APP" ]; then
  echo; echo "==> 最终 profile 覆盖设备:"
  security cms -D -i "$LAST_GOOD_APP/embedded.mobileprovision" 2>/dev/null \
    | awk '/ProvisionedDevices/{f=1;next} /<\/array>/{if(f){f=0}} f'
  echo "    到期时间:"
  security cms -D -i "$LAST_GOOD_APP/embedded.mobileprovision" 2>/dev/null \
    | grep -A1 'ExpirationDate' | tail -1

  STAGE="$(mktemp -d)"
  mkdir -p "$STAGE/Payload"
  cp -R "$LAST_GOOD_APP" "$STAGE/Payload/"
  (cd "$STAGE" && zip -qry "$IPA_OUT" Payload)
  rm -rf "$STAGE"
  echo "==> 已更新 IPA: $IPA_OUT"
else
  echo; echo "（本次无成功编译，跳过 IPA 重打；上次 IPA 保持不变）"
fi

echo
echo "提示：7 天内再跑一次即可续期。iOS 16+ 设备首次需开「开发者模式」，"
echo "      每台首次装机需在「设置 → 通用 → VPN 与设备管理」信任开发者。"

# 设备侧状态（离线 / 待信任 / 待开开发者模式）都不算错误，脚本始终正常结束
exit 0
