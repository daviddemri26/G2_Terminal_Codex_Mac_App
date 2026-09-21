# G2 Bridge Guide — Even Hub companion

A small, offline guide for people using **Even G2 + Even Terminal + the Codex Mac
app**. The glasses show four native topics: Set up, Daily use, Troubleshoot, and
About. The phone screen carries fuller instructions and ordinary reference links
to the [setup tutorial](https://daviddemri26.github.io/G2_Terminal_Codex_Mac_App/)
and [GitHub support](https://github.com/daviddemri26/G2_Terminal_Codex_Mac_App/issues).

This is a useful guide, not a second terminal. It does not chat, start Codex,
pair devices, install the Mac bridge, inspect the network, or display live bridge
status. Installing it does not install Even Terminal. It needs no Mac connection
to read its bundled instructions. External links need internet; if a link does
not open in the phone WebView, select and copy its displayed address into a
browser. There is no documented system-browser or application-launch promise.

## Isolated development

Use Node **26.9.0** and run these commands from this directory:

```sh
npm ci --ignore-scripts
npm run check
npm run preview -- --port 4178 --strictPort
```

The preview is at `http://127.0.0.1:4178`. A regular browser can read the phone
guide. If no Even bridge arrives, its status changes to a clear phone-only
fallback after six seconds. It never claims that your Mac or glasses connection
has been verified. These commands do not touch the installed Mac app, runtime,
pairing configuration, or root project's npm dependencies.

With that preview server running, open a second terminal in this directory to
launch the locked simulator (a local development tool, not the installed bridge):

```sh
./node_modules/.bin/evenhub-simulator http://127.0.0.1:4178 --automation-port 9899
```

To prepare a local candidate package after a successful build:

```sh
mkdir -p .build
./node_modules/.bin/evenhub pack app.json dist --sdk-ver 0.0.14 -o .build/g2-bridge-guide-0.1.0.ehpk
```

The pack command looks up the SDK's minimum host-app version in npm. It does not
upload the package or check/reserve the package ID. Do not add `--check` until
you deliberately want an account-dependent availability check.

The production build is `dist/`, including relative asset URLs and the SDK's
verbatim license notice. Dependencies and build outputs are ignored. Source is
in `src/`; `app.json` is the Even Hub manifest. The package ID is proposed and its
availability has not been checked or reserved.

## Controls and lifecycle

- On the root native list, scroll to highlight a topic and tap to open it.
- On a detail page, scroll to read and double-tap to return to the menu.
- On the root page, double-tap requests the **system exit confirmation**, using
  `shutDownPageContainer(1)`. Cancelling that dialog leaves the guide usable.
- Only one container captures input on each page. A single event subscription
  serializes page changes. Failed updates keep the previously rendered page.
- Background events pause input handling; foreground events restore it. A system
  exit unsubscribes without trying to restart or silently exit the app.

The phone instructions and glasses pages remain separate surfaces. Opening an
accordion on the phone does not send a command to the glasses or Mac.

## Versions and validation

| Tool | Exact version | Purpose |
| --- | --- | --- |
| Even Hub SDK | 0.0.14 | Bundled runtime |
| Even Hub CLI | 0.1.14 | Local package tooling |
| Even Hub Simulator | 0.9.5 | Local simulated-device checks |
| TypeScript | 5.9.3 | Strict type checking; compatible with the CLI's TS 5 peer range |
| Vite | 8.3.0 | Local build / preview |

The SDK npm package declares minimum Even App **2.2.9**. Packaging must use
`--sdk-ver 0.0.14` so the CLI derives the correct app floor instead of using a
different latest SDK. This floor is a platform requirement, not evidence of a
physical-device test or certification of the Mac bridge. The Mac bridge's own
compatibility remains in [../compatibility.json](../compatibility.json).

Tests use the actual SDK container validator and a mocked bridge to verify
navigation, item-zero handling, invalid input, serialized SDK calls, failed
updates, lifecycle events, and the system exit confirmation. Browser/simulator
checks and physical phone/glasses checks must be reported separately. No tests
send prompts, create conversations, or contact the installed Mac bridge.

The submission notes and prepared store assets are in
[../distribution/even-hub/](../distribution/even-hub/). Do not treat a local
package, simulator run, or manifest as store approval. No submission is made by
the build command.

## Privacy and dependencies

The manifest requests no permissions. The guide makes no application network
requests, uses no analytics or persistence, and reads no conversations, tokens,
device sensors, accounts, or local bridge data. Ordinary links are opened only
when selected; destination sites have their own policies. The SDK communicates
with the host to render pages and receive user interface events.

The locked SDK is published as MIT; its `LICENSE` text is copied verbatim into
each production build by `scripts/copy-notices.mjs`, preserving the original
copyright holder as supplied. Development dependencies remain outside the
shipped web build; their license declarations and notices are in their installed
npm packages. No license is granted or invented for this project's own code.

The implementation follows the official
[first app guide](https://hub.evenrealities.com/docs/get-started/quickstart/first-app),
[display system](https://hub.evenrealities.com/docs/build/display),
[device events](https://hub.evenrealities.com/docs/build/device-apis), and
[packaging documentation](https://hub.evenrealities.com/docs/ship/packaging),
checked on September 21, 2026. It is an independent community companion.
