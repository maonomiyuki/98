# PC-98風ドット変換 Webアプリ

静的Webアプリ（Vite構成）です。クライアント側Canvas処理のみで、PC-98風変換（640x400 / RGB各4bit / 8色・16色 / 自動パレット選択）を行います。

## 開発

```bash
npm install
npm run dev
```

## ビルド（GitHub Pages向け）

```bash
npm run build
```

`vite.config.js` で `base: './'` を指定しているため、静的配信でそのまま動作します。
