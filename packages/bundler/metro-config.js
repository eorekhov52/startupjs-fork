// To pass existing config for modification, pass it as 'upstreamConfig' in options:
//   config = getDefaultConfig(__dirname, { upstreamConfig })
exports.getDefaultConfig = function getDefaultConfig (projectRoot, { upstreamConfig } = {}) {
  upstreamConfig ??= getUpstreamConfig(projectRoot)
  const isExpo = checkIfExpo(upstreamConfig)
  return {
    ...upstreamConfig,
    transformer: {
      ...upstreamConfig.transformer,
      babelTransformerPath: require.resolve('./metro-babel-transformer.js')
    },
    resolver: {
      ...upstreamConfig.resolver,
      assetExts: upstreamConfig.resolver.assetExts.filter(ext => ext !== 'svg'),
      sourceExts: Array.from(new Set([
        ...(isExpo ? ['expo.ts', 'expo.tsx', 'expo.js', 'expo.jsx', 'expo.mjs', 'expo.cjs'] : []),
        ...(upstreamConfig.resolver.sourceExts || []),
        ...['mjs', 'cjs', 'md', 'mdx', 'css', 'styl', 'svg']
      ]))
    }
  }
}

function getUpstreamConfig (projectRoot) {
  try {
    // Expo
    return require('expo/metro-config').getDefaultConfig(projectRoot, {
      // startupjs has a custom CSS implementation so we don't need to use Expo's
      isCSSEnabled: false
    })
  } catch (err) {
    try {
      // React Native 0.73+
      return require('@react-native/metro-config').getDefaultConfig(projectRoot)
    } catch (err) {
      // React Native <0.73
      return require('metro-config').getDefaultConfig()
    }
  }
}

function checkIfExpo (upstreamConfig) {
  if (/[\\/]@expo[\\/]metro-config[\\/]/.test(upstreamConfig?.transformer?.babelTransformerPath)) {
    return true
  }
  try {
    const path = require.resolve('expo/metro-config')
    return Boolean(path)
  } catch (err) {
    return false
  }
}
