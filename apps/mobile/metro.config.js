// Expo SDK 52+ configures monorepo watch folders automatically; this keeps the
// engine's explicit `.ts` import specifiers resolvable by Metro.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.sourceExts = Array.from(new Set([...config.resolver.sourceExts, 'ts', 'tsx']));
module.exports = config;
