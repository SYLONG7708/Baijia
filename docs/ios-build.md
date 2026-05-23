# iPhone Build Notes

This Windows machine can build the web/PWA and Android wrapper. Native iOS IPA output requires macOS with Xcode.

## PWA Install

1. Deploy `Baijia Pro` behind HTTPS.
2. Open the URL in Safari on iPhone.
3. Tap Share.
4. Tap Add to Home Screen.

This uses the same API data and does not require reinstalling when records change.

## Capacitor iOS

On macOS:

```bash
npm install
npm run build:web
npx cap add ios
npx cap sync ios
npx cap open ios
```

In Xcode, set the bundle identifier, signing team, and deployment target, then archive for TestFlight or App Store distribution.
