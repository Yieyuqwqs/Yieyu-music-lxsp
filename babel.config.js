module.exports = (api) => {
  api.cache(true)
  // Metro 在 release（--dev false）时 caller.isDev === false；只有那时才裁 console
  const isDev = api.caller((caller) => !!(caller && caller.isDev))

  return {
    presets: ['module:@react-native/babel-preset'],
    plugins: [
      // 必须在最前：先裁 console，后续插件就不用再处理这些节点
      ...(isDev ? [] : [require('./plugins/strip-console.cjs')]),
    '@babel/plugin-proposal-export-namespace-from',
    [
      'module-resolver',
      {
        root: ['.'],
        extensions: [
          '.android.ts',
          '.ios.ts',
          '.android.tsx',
          '.ios.tsx',
          '.tsx',
          '.ts',
          '.android.js',
          '.ios.js',
          '.android.jsx',
          '.ios.jsx',
          '.jsx',
          '.js',
          '.json',
        ],
        alias: {
          '@': './src',
          // '@config': './src/config',
          // '@store': './src/store',
          // '@components': './src/components',
          // '@navigation': './src/navigation',
          // '@screens': './src/screens',
          // '@theme': './src/theme',
        },
      },
    ],
      // 必须在最后：worklet 转换要看到已解析的模块路径
      'react-native-reanimated/plugin',
    ],
  }
}
