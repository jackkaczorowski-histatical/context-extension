# Chrome Web Store Submission Checklist

Run through every item before each CWS submission.

## Functional Testing
- [ ] Start/stop capture works on YouTube
- [ ] Cards appear within 15 seconds of capture start
- [ ] Stock prices load on finance content
- [ ] Export produces a study guide with attribution footer
- [ ] Settings page opens and saves changes
- [ ] History shows past sessions
- [ ] "Tell me more" returns useful responses
- [ ] Usage cap triggers at 30 minutes (test with modified cap)
- [ ] Audio capture disclosure shows on first use

## Error Testing
- [ ] No errors in service worker console (chrome://extensions → Service Worker)
- [ ] No errors in content script console (page DevTools → Console)
- [ ] Extension recovers from stream death (pause/unpause video)
- [ ] Extension handles API timeout gracefully

## Compliance
- [ ] Privacy policy URL resolves: https://context-extension-zv8d.vercel.app/privacy
- [ ] Terms of service URL resolves: https://context-extension-zv8d.vercel.app/terms
- [ ] All permissions in manifest.json are justified
- [ ] No eval(), new Function(), or document.write() in codebase
- [ ] content_security_policy is set in manifest.json
- [ ] Financial disclaimer appears on stock cards

## Store Listing
- [ ] Extension name: Context
- [ ] Short description (132 chars max)
- [ ] Full description
- [ ] 5 screenshots (1280x800 or 640x400)
- [ ] Extension icon (128x128)
- [ ] Category: Productivity
- [ ] Single purpose: "Provide real-time contextual information about audio content playing in the browser"

## Health
- [ ] /api/health returns all green
- [ ] UptimeRobot monitors are active
- [ ] Sentry DSN is set in Vercel env vars
- [ ] Spending alerts set on Vercel, Anthropic, Deepgram
