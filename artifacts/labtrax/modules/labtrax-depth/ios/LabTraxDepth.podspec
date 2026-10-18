Pod::Spec.new do |s|
  s.name           = 'LabTraxDepth'
  s.version        = '1.0.0'
  s.summary        = 'LabTrax iOS depth auxiliary data extraction'
  s.description    = 'Extracts calibrated depth and camera metadata for LabTrax scans.'
  s.homepage       = 'https://labtrax.app'
  s.license        = { :type => 'Proprietary', :text => 'Copyright Southern Dental Restoration, LLC. All rights reserved.' }
  s.author         = { 'Southern Dental Restoration, LLC' => 'support@labtrax.app' }
  s.platforms      = { :ios => '11.0' }
  s.source         = { :git => 'https://github.com/labtrax/labtrax-depth.git', :tag => s.version.to_s }
  s.source_files   = '*.swift'
  s.swift_version  = '5.0'
  s.dependency 'ExpoModulesCore'
end