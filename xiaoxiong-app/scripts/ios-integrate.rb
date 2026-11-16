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

# ── 5) gateway/ 文件夹引用（folder reference，Copy Bundle Resources；新壳兜底）──
gw_ref = find_ref(proj, 'gateway') || find_ref(proj, '../gateway')
unless gw_ref
  gw_ref = proj.main_group.new_reference('gateway')
  gw_ref.last_knownFileType = 'folder'
  gw_ref.name = 'gateway'
end
app_target.resources_build_phase.add_file_reference(gw_ref, true)
puts '[integrate] gateway/ 文件夹引用已在 Copy Bundle Resources'

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

puts '[integrate] 完成'
