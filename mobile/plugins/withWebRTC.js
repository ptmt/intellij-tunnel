const {
  AndroidConfig,
  WarningAggregator,
  withInfoPlist,
  createRunOncePlugin,
} = require("expo/config-plugins");

const CAMERA_USAGE = "Allow $(PRODUCT_NAME) to access your camera";
const MICROPHONE_USAGE = "Allow $(PRODUCT_NAME) to access your microphone";

const withPermissions = (config, props = {}) => {
  return withInfoPlist(config, (config) => {
    const { cameraPermission, microphonePermission } = props;
    config.modResults.NSCameraUsageDescription =
      cameraPermission ||
      config.modResults.NSCameraUsageDescription ||
      CAMERA_USAGE;
    config.modResults.NSMicrophoneUsageDescription =
      microphonePermission ||
      config.modResults.NSMicrophoneUsageDescription ||
      MICROPHONE_USAGE;
    return config;
  });
};

const withBitcodeDisabled = (config) => {
  if (!config.ios) {
    config.ios = {};
  }

  if (config.ios?.bitcode != null && config.ios?.bitcode !== false) {
    WarningAggregator.addWarningIOS(
      "ios.bitcode",
      "react-native-webrtc plugin is overwriting project bitcode settings. WebRTC requires bitcode to be disabled for builds, targeting physical iOS devices."
    );
  }

  config.ios.bitcode = false;
  return config;
};

const withWebRTC = (config, props = {}) => {
  const _props = props || {};

  // iOS
  config = withPermissions(config, _props);
  config = withBitcodeDisabled(config);

  // Android
  config = AndroidConfig.Permissions.withPermissions(config, [
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.CAMERA",
    "android.permission.INTERNET",
    "android.permission.MODIFY_AUDIO_SETTINGS",
    "android.permission.RECORD_AUDIO",
    "android.permission.SYSTEM_ALERT_WINDOW",
    "android.permission.WAKE_LOCK",
    "android.permission.BLUETOOTH",
  ]);

  return config;
};

module.exports = createRunOncePlugin(
  withWebRTC,
  "react-native-webrtc",
  "UNVERSIONED"
);
