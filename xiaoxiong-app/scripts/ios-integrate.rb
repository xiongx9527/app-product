#!/usr/bin/env ruby
# 幂等把 XiaoxiongGateway.framework 集成进 DCloud iOS 离线壳工程（HBuilder-Hello），
# 替代旧的「手动拖 Swift 文件进 Xcode」流程。由 package-ios-offline.mjs 调用。
#
# 幂等：重复运行无副作用；已存在则跳过（add_file_reference 第二参 true 去重）。
# 迁移：若壳工程仍有旧式手动注入的 GatewayNode.swift / AppDelegate+Gateway.swift
#   （源已迁至 native/ios/app 的 framework 工程），自动从 target / 工程树 / 磁盘移除。
#
# 用法：
#   ruby scripts/ios-integrate.rb --project <壳工程.xcodeproj> [--framework XiaoxiongGateway]

require 'xcodeproj'
require 'optparse'
require 'fileutils'

options = { framework: 'XiaoxiongGateway' }
OptionParser.new do |o|
  o.on('--project PATH', '壳工程 .xcodeproj 路径') { |v| options[:project] = v }
  o.on('--framework NAME', 'framework 名（默认 XiaoxiongGateway）') { |v| options[:framework] = v }
end.parse!(ARGV)

proj_path = options[:project]
abort '缺 --project <壳工程.xcodeproj>' unless proj_path && File.directory?(proj_path)

proj = Xcodeproj::Project.open(proj_path)
fw = options[:framework]
shell_root = File.dirname(proj_path)

app_target = proj.targets.find { |t| t.product_type == 'com.apple.product-type.application' }
abort '壳工程里找不到 application target' unless app_target
puts "[integrate] 主 target: #{app_target.name}"

# ── 0) FRAMEWORK_SEARCH_PATHS：让 <XiaoxiongGateway/XiaoxiongGateway-Swift.h> 能找到
#      壳工程 Frameworks/ 下的预构建 framework 头（幂等）──
app_target.build_configurations.each do |c|
  fsp = c.build_settings['FRAMEWORK_SEARCH_PATHS'] || ['$(inherited)']
  fsp = fsp.is_a?(Array) ? fsp : [fsp]
  unless fsp.any? { |p| p.to_s.include?('$(PROJECT_DIR)/Frameworks') || p.to_s.include?('$(SRCROOT)/Frameworks') }
    fsp << '$(PROJECT_DIR)/Frameworks'
    c.build_settings['FRAMEWORK_SEARCH_PATHS'] = fsp
    puts "[integrate] FRAMEWORK_SEARCH_PATHS += \$(PROJECT_DIR)/Frameworks (#{c.name})"
  end
end

# ── 1) 迁移清理：旧式手动注入的工厂 Swift 文件（framework 方式已替代）──
%w[GatewayNode.swift AppDelegate+Gateway.swift].each do |name|
  refs = proj.files.select { |f| f.path == name || f.display_name == name }
  refs.each do |ref|
    ref.build_files.each(&:remove_from_project)
    ref.remove_from_project
  end
  Dir.glob(File.join(shell_root, '**', name)).each do |p|
    FileUtils.rm(p)
    puts "[migrate] 已删除旧注入文件 #{p}"
  end
  puts "[migrate] 已从 target 移除 #{name}" if refs.any?
end

# ── 2) 工具函数：按相对路径找/建文件引用 ──
def find_ref(proj, rel_path)
  proj.files.find { |f| f.path == rel_path }
end

def ensure_ref(proj, rel_path, name)
  ref = find_ref(proj, rel_path)
  return ref if ref
  group = proj.main_group['Frameworks'] || proj.main_group.new_group('Frameworks')
  ref = group.new_reference(rel_path)
  ref.name = name
  ref
end

# ── 3) XiaoxiongGateway.framework：link + Embed(sign on copy) ──
fw_rel = "Frameworks/#{fw}.framework"
fw_ref = ensure_ref(proj, fw_rel, "#{fw}.framework")
fw_ref.last_known_file_type = 'wrapper.framework'
app_target.frameworks_build_phase.add_file_reference(fw_ref, true)

embed = app_target.copy_files_build_phases.find do |ph|
  ph.name == 'Embed Frameworks' || ph.dst_subfolder_spec.to_s == '10'
end
embed ||= app_target.new_copy_files_build_phase('Embed Frameworks')
embed.dst_subfolder_spec = '10'
bf = embed.add_file_reference(fw_ref, true)
bf.settings = { 'ATTRIBUTES' => %w[CodeSignOnCopy RemoveHeadersOnCopy] }
puts "[integrate] #{fw}.framework 已接入 link + Embed(CodeSignOnCopy)"

# ── 4) NodeMobile.xcframework：link + Embed（新壳兜底；已有则幂等跳过）──
node_ref = ensure_ref(proj, 'Frameworks/NodeMobile.xcframework', 'NodeMobile.xcframework')
node_ref.last_known_file_type = 'wrapper.xcframework'
app_target.frameworks_build_phase.add_file_reference(node_ref, true)
nbf = embed.add_file_reference(node_ref, true)
nbf.settings = { 'ATTRIBUTES' => %w[CodeSignOnCopy RemoveHeadersOnCopy] }
puts '[integrate] NodeMobile.xcframework 已接入 link + Embed'

# ── 4b) 系统 framework：AudioQueue 播放需要 AudioToolbox（系统库只 link，不 Embed）──
%w[AudioToolbox.framework AVFoundation.framework].each do |sysfw|
  next if app_target.frameworks_build_phase.files.any? { |bf| bf.file_ref&.path == sysfw || bf.display_name == sysfw }
  sys_ref = proj.files.find { |f| f.path == sysfw }
  unless sys_ref
    group = proj.main_group['Frameworks'] || proj.main_group.new_group('Frameworks')
    sys_ref = group.new_reference(sysfw)
    sys_ref.last_known_file_type = 'wrapper.framework'
    sys_ref.name = sysfw
    sys_ref.source_tree = 'SDKROOT'
    sys_ref.path = "System/Library/Frameworks/#{sysfw}"
  end
  app_target.frameworks_build_phase.add_file_reference(sys_ref, true)
  puts "[integrate] 系统库 #{sysfw} 已 link"
end

# ── 5) gateway/ 文件夹引用（folder reference，Copy Bundle Resources；新壳兜底）──
gw_ref = find_ref(proj, 'gateway') || find_ref(proj, '../gateway')
unless gw_ref
  gw_ref = proj.main_group.new_reference('gateway')
  gw_ref.last_knownFileType = 'folder'
  gw_ref.name = 'gateway'
end
app_target.resources_build_phase.add_file_reference(gw_ref, true)
puts '[integrate] gateway/ 文件夹引用已在 Copy Bundle Resources'

# ── 5b) app-product-wake 原生录音插件（iOS，参照 Android WakeModule.java）──
#   把 AppProductWakeModule.h/.m 从源工程拷进壳工程 HBuilder-Hello 目录，加入主 target
#   Sources，并在 bridging header 暴露 DCUniModule.h。全部幂等。
wake_group = proj.main_group['HBuilder-Hello'] || proj.main_group
wake_src = File.expand_path('../native/ios/app/XiaoxiongGateway.xcodeproj', __dir__)
# AppProductWakeModule + KwsEngine（iOS KWS 常驻唤醒，sherpa-onnx 封装）一并拷入主 target
%w[AppProductWakeModule.h AppProductWakeModule.m KwsEngine.h KwsEngine.m PcmUploader.h PcmUploader.m].each do |fname|
  dst = File.join(shell_root, 'HBuilder-Hello', fname)
  src = File.join(wake_src, fname)
  if File.exist?(src)
    unless File.exist?(dst) && FileUtils.compare_file(src, dst)
      FileUtils.cp(src, dst)
      puts "[wake] 已拷贝 #{fname} -> #{dst}"
    end
    # pbxproj 文件引用（裸文件名，因 wake_group 已有 path=HBuilder-Hello）
    ref = wake_group.files.find { |fr| fr.path == fname || fr.display_name == fname }
    unless ref
      ref = wake_group.new_reference(fname)
      ref.last_known_file_type = fname.end_with?('.h') ? 'sourcecode.c.h' : 'sourcecode.c.objc'
      puts "[wake] pbxproj 已加引用 #{fname}"
    end
    if fname.end_with?('.m') && !app_target.source_build_phase.files.any? { |bf| bf.file_ref&.path == fname }
      app_target.source_build_phase.add_file_reference(ref, true)
      puts "[wake] #{fname} 已加入主 target Sources"
    end
  else
    puts "[wake] 警告：源不存在 #{src}"
  end
end

# Header Search Paths 兜底：让 bridging header 的 #import "DCUniModule.h" 能找到
app_target.build_configurations.each do |c|
  hsp = c.build_settings['HEADER_SEARCH_PATHS'] || ['$(inherited)']
  hsp = hsp.is_a?(Array) ? hsp : [hsp]
  unless hsp.any? { |p| p.to_s.include?('Headers/Public/uniapp') }
    hsp << '$(PROJECT_DIR)/Pods/Headers/Public/uniapp'
    hsp << '$(PODS_ROOT)/Headers/Public/uniapp'
    c.build_settings['HEADER_SEARCH_PATHS'] = hsp
    puts "[wake] HEADER_SEARCH_PATHS += uniapp headers (#{c.name})"
  end
end

# ── 5c) iOS KWS：sherpa-onnx xcframework（dynamic，Embed & Sign）+ 模型 folder reference ──
# 用 sherpa-onnx-v2.0.2-ios-shared-onnxruntime-static：sherpa 为 dynamic framework，
# onnxruntime 已静态链入其中（含 CoreML EP），解决单独 link 时的 OrtGetApiBase 未定义。
# dynamic framework 必须 Embed & Sign（CodeSignOnCopy）。
factory_root = File.expand_path('../native/ios/app', __dir__)   # native/ios/app（工厂源）
sherpa_src = File.join(factory_root, 'Frameworks', 'SherpaOnnxC.xcframework')
sherpa_dst = File.join(shell_root, 'Frameworks', 'SherpaOnnxC.xcframework')

# 清理旧的 static 版 sherpa-onnx.xcframework 引用（之前构建加过，残留会重复定义）
proj.files.select { |f| f.path.to_s.include?('sherpa-onnx.xcframework') }.each do |ref|
  ref.build_files.each(&:remove_from_project)
  ref.remove_from_project
end
FileUtils.rm_rf(File.join(shell_root, 'Frameworks', 'sherpa-onnx.xcframework'))

if File.directory?(sherpa_src)
  unless File.exist?(File.join(sherpa_dst, 'Info.plist'))
    FileUtils.mkdir_p(File.dirname(sherpa_dst))
    FileUtils.cp_r(sherpa_src, sherpa_dst)
    puts "[kws] 已拷贝 SherpaOnnxC.xcframework -> #{sherpa_dst}"
  end

  sherpa_fw_rel = 'Frameworks/SherpaOnnxC.xcframework'
  sherpa_ref = ensure_ref(proj, sherpa_fw_rel, 'SherpaOnnxC.xcframework')
  sherpa_ref.last_known_file_type = 'wrapper.xcframework'
  app_target.frameworks_build_phase.add_file_reference(sherpa_ref, true)
  # dynamic framework：Embed & Sign
  unless embed.files.any? { |bf| bf.file_ref&.path == sherpa_fw_rel }
    sbf = embed.add_file_reference(sherpa_ref, true)
    sbf.settings = { 'ATTRIBUTES' => %w[CodeSignOnCopy RemoveHeadersOnCopy] }
  end
  puts '[kws] SherpaOnnxC.xcframework 已 link + Embed & Sign'

  # 头文件搜索路径：device + simulator 两个 slice 的 SherpaOnnxC.framework/Headers
  app_target.build_configurations.each do |c|
    hsp = c.build_settings['HEADER_SEARCH_PATHS'] || ['$(inherited)']
    hsp = hsp.is_a?(Array) ? hsp : [hsp]
    # 先清掉旧 static 版的 header path（含 sherpa-onnx.xcframework），否则去重判断误命中
    hsp.reject! { |x| x.to_s.include?('sherpa-onnx.xcframework') }
    ['ios-arm64', 'ios-arm64_x86_64-simulator'].each do |slice|
      p = "$(PROJECT_DIR)/Frameworks/SherpaOnnxC.xcframework/#{slice}/SherpaOnnxC.framework/Headers"
      hsp << p unless hsp.include?(p)
    end
    c.build_settings['HEADER_SEARCH_PATHS'] = hsp
    puts "[kws] HEADER_SEARCH_PATHS += sherpa C headers (#{c.name})"
  end
else
  puts "[kws] 警告：sherpa xcframework 不存在 #{sherpa_src}（先跑 scripts/prepare-kws-assets.sh）"
end

# KwsResources 模型目录：拷进壳工程并建 folder reference（Copy Bundle Resources）
KWS_MODEL = 'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20'
kws_res_src = File.join(factory_root, 'KwsResources', KWS_MODEL)
kws_res_dst = File.join(shell_root, 'HBuilder-Hello', 'KwsResources', KWS_MODEL)
if File.directory?(kws_res_src)
  unless File.exist?(File.join(kws_res_dst, 'tokens.txt'))
    FileUtils.mkdir_p(File.dirname(kws_res_dst))
    FileUtils.cp_r(kws_res_src, kws_res_dst)
    puts "[kws] 已拷贝模型资源 -> #{kws_res_dst}"
  end
  kws_parent_ref = proj.main_group['HBuilder-Hello'] || proj.main_group
  # folder reference 用 kws_parent_ref 下相对路径（裸 KwsResources），确保 bundle 内保留目录结构
  kws_ref = kws_parent_ref.files.find { |fr| fr.path == 'KwsResources' || fr.display_name == 'KwsResources' }
  unless kws_ref
    kws_ref = kws_parent_ref.new_reference('KwsResources')
    kws_ref.last_known_file_type = 'folder'
    kws_ref.name = 'KwsResources'
  end
  app_target.resources_build_phase.add_file_reference(kws_ref, true)
  puts '[kws] KwsResources folder reference 已加入 Copy Bundle Resources'
else
  puts "[kws] 警告：模型资源不存在 #{kws_res_src}"
end

proj.save
puts "[integrate] 已保存 #{proj_path}"

# ── 6) AppDelegate.m：framework 头 + GatewayLauncher 调用（幂等）──
ad_files = Dir.glob(File.join(shell_root, '**', 'AppDelegate.m')).reject { |p| p =~ %r{/Pods/|/build/} }
abort '壳工程里找不到 AppDelegate.m' if ad_files.empty?

ad_files.each do |ad|
  s = File.read(ad)
  before = s
  s = s.gsub(/^\s*\[self xiaoxiong_startEmbeddedGateway\];/,
             '[GatewayLauncher startEmbeddedGateway];')
  s = s.gsub(%r{// 自动生成的 Swift 接口头（暴露 GatewayNode\.swift / AppDelegate\+Gateway\.swift 里的 @objc 方法）\n#(?:import|include) "HBuilder-Swift\.h";?}) do
    %(#import "HBuilder-Swift.h"\n// 内嵌网关 framework 的 Swift 接口头（GatewayLauncher.startEmbeddedGateway）\n#import <XiaoxiongGateway/XiaoxiongGateway-Swift.h>)
  end
  if s == before
    puts "[appdelegate] #{ad} 无需修改"
  else
    File.write(ad, s)
    puts "[appdelegate] 已更新 #{ad}（GatewayLauncher 调用 + framework 头）"
  end
end

# ── 6b) SceneDelegate.m：退后台/回前台调网关静音保活（幂等）──
# 本 App 声明了 UIApplicationSceneManifest（delegate=SceneDelegate）。iOS 13+ 一旦走
# SceneDelegate，前后台生命周期只进 SceneDelegate 的 sceneDidEnterBackground:/
# sceneWillEnterForeground:，AppDelegate 的同名方法永不调用——所以保活必须注入这里。
# 哨兵 xiaoxiong-gw-keepalive：import 用 sub 只插一次；两处方法调用用 gsub，s != before 才写回。
scene_files = Dir.glob(File.join(shell_root, '**', 'SceneDelegate.m')).reject { |p| p =~ %r{/Pods/|/build/} }
scene_files.each do |sd|
  s = File.read(sd)
  before = s
  unless s.include?('xiaoxiong-gw-keepalive')
    s = s.sub(/(#import "PDRCore\.h")/) do
      %(#{$1}\n// xiaoxiong-gw-keepalive: 内嵌网关静音保活入口\n#import <XiaoxiongGateway/XiaoxiongGateway-Swift.h>)
    end
    s = s.gsub(/(\[PDRCore handleSysEvent:PDRCoreSysEventEnterBackground withObject:nil\];)/) do
      %(#{$1}\n    [GatewayLauncher beginGatewayKeepAlive]; // xiaoxiong-gw-keepalive)
    end
    s = s.gsub(/(\[PDRCore handleSysEvent:PDRCoreSysEventEnterForeGround withObject:nil\];)/) do
      %(#{$1}\n    [GatewayLauncher endGatewayKeepAlive]; // xiaoxiong-gw-keepalive)
    end
  end
  if s == before
    puts "[scenedelegate] #{sd} 无需修改（保活已注入或场景不匹配）"
  else
    File.write(sd, s)
    puts "[scenedelegate] 已更新 #{sd}（退后台静音保活 begin/end 调用）"
  end
end

# ── 7) bridging header：暴露 DCUniModule.h 给 Swift 工程（WakeModule 是 ObjC，实际不需要；
#       但保留 #import 以便 Swift 侧如需调用也无碍；用哨兵幂等）──
bh = File.join(shell_root, 'HBuilder-Hello', 'HBuilder-Bridging-Header.h')
if File.exist?(bh)
  s = File.read(bh)
  unless s.include?('DCUniModule.h')
    s = s.rstrip + "\n// xiaoxiong-wake: iOS 录音插件基类\n#import \"DCUniModule.h\"\n"
    File.write(bh, s)
    puts '[wake] bridging header 已加 DCUniModule.h'
  end
end

# ── 8) Info.plist：dcloud_uniplugins 注册 app-product-wake → AppProductWakeModule ──
plist_files = Dir.glob(File.join(shell_root, '**', '*-Info.plist')).reject { |p| p =~ %r{/Pods/|/build/} }
plist_files.each do |pl|
  s = File.read(pl)
  next if s.include?('app-product-wake') # 幂等
  # 在 dcloud_uniplugins 的 <array> 后插入一个插件 dict（与现有 DCRichAlert 同结构）。
  marker = '<key>dcloud_uniplugins</key>'
  idx = s.index(marker)
  unless idx
    puts "[wake] 警告：#{pl} 无 dcloud_uniplugins，跳过注册"
    next
  end
  arr_start = s.index('<array>', idx)
  unless arr_start
    puts "[wake] 警告：#{pl} dcloud_uniplugins 后无 array，跳过"
    next
  end
  insert_at = arr_start + '<array>'.length
  plugin = <<~XML.chomp
    
    		<dict>
    			<key>hooksClass</key>
    			<string>AppProductWakeModule</string>
    			<key>plugins</key>
    			<array>
    				<dict>
    					<key>class</key>
    					<string>AppProductWakeModule</string>
    					<key>name</key>
    					<string>app-product-wake</string>
    					<key>type</key>
    					<string>module</string>
    				</dict>
    			</array>
    		</dict>
  XML
  s.insert(insert_at, plugin)
  File.write(pl, s)
  puts "[wake] Info.plist 已注册 app-product-wake -> AppProductWakeModule (#{pl})"
end

puts '[integrate] 完成'
