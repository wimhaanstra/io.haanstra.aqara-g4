# Aqara G4 Doorbell for Homey

A Homey app for the Aqara G4 video doorbell. It talks to the doorbell directly over HomeKit (HAP) on your local network: no Aqara cloud, no extra hardware.

- **Doorbell presses** start a Flow, with a snapshot of the visitor as an image token.
- **Live video** in the Homey app, the web app and dashboards, on any number of screens at once.
- **Motion** (`alarm_motion`) and **battery** (as reported by the doorbell).
- **Snapshots**: the device's camera image, plus a "Take a snapshot" Flow action.
- **Doorbell settings**: chime on/off, chime volume, speaker volume, microphone, camera on/off (privacy), night vision and status light. The app subscribes to HomeKit events for these, so changes made elsewhere should follow (not yet tried on the real doorbell).
- **Flow actions**: set chime volume, turn the chime on or off, turn the camera on or off, make the doorbell beep (HomeKit identify).

Audio is not included yet: the doorbell sends AAC-ELD, which has to be converted before Homey can play it.

Requires Homey Pro (2023 or later), Homey Pro mini or Homey Self-Hosted Server, version 12.12.0 or newer.

## Pairing

A HomeKit accessory accepts only one controller. Before adding the doorbell in Homey, remove it from Apple Home or any other HomeKit app.

Removing it in Homey's HomeKit Controller app did not clear the pairing on the doorbell itself. A HomeKit reset in Aqara Home did, but that also cleared the doorbell's Wi-Fi, so it had to be set up in Aqara Home again (without adding it to Apple Home).

Then add **Aqara G4 Doorbell** in Homey and either type the 8-digit setup code or scan the HomeKit QR code. Scanning also selects the right doorbell automatically. Deleting the device in Homey removes its pairing from the doorbell.

## Device settings

| Setting | Options | Notes |
| --- | --- | --- |
| Live video quality | High (1080p), Normal (720p, default), Low (360p) | Lower quality starts faster and uses less Wi-Fi |

## How it fits together

```
G4 --HAP (TCP, ChaCha20)--> HapClient --events--> device.ts (capabilities, Flows)
   |                            '-- /resource snapshots --> Homey Images
   '--SRTP/UDP (H.264)--> CameraStream --> StreamHub --> RtspServer --RTSP/TCP--> Homey's go2rtc --> every viewer
```

### Why RTSP and not WebRTC from the app

An earlier version served every viewer from the app over WebRTC (werift). Homey stops apps that keep using too much CPU ("CPU Warning Limit Reached"), and on a Self-Hosted Server that happened at roughly 25% of one core. Every packet the app sends costs a system call, and those are expensive inside Homey's app sandbox.

| Live video | 1 viewer | 3 viewers |
| --- | --- | --- |
| WebRTC from the app, per viewer (1080p, removed) | ~21% | ~28–31%, then stopped by Homey |
| One RTSP stream to Homey (720p, current) | ~5% | ~5% |

For RTSP videos, Homey runs the stream through its own go2rtc outside the app and shares one connection to the app between all viewers. For WebRTC videos, every viewer's offer comes to the app. Dropping WebRTC also shrank the app package from about 26 MB to about 1 MB. The RTSP URL has a random token, so other devices on the network can't watch the doorbell.

Handing go2rtc a `homekit://` URL directly does not work: Homey falls back to direct playback and VLC can't open it.

## Project layout

| Path | What it does |
| --- | --- |
| `lib/hap/` | HomeKit client: pair-setup/verify, encrypted session, characteristics, events, pairings, TLV8, camera TLVs, setup codes and QR payloads |
| `lib/stream/` | SRTP/SRTCP, RTCP keep-alive, H.264 helpers, one shared camera stream per device and the RTSP server |
| `lib/doorbellSettings.ts` | Which HomeKit characteristics map to which Homey capabilities |
| `drivers/doorbell/` | Homey driver, device and the pairing view |
| `tools/` | Spike tools that talk to the doorbell from your computer, the pair-view generator and the store-art generator |
| `tests/` | Unit tests and end-to-end tests against a simulated HomeKit camera |

The pairing view `drivers/doorbell/pair/setup.html` is **generated**. Edit `tools/pair-view/setup.html` and run `noodge app:pair-view`.

## Development

All commands are in `noodge.yaml` (`noodge list`):

```bash
noodge app:test       # unit + simulated-camera tests
noodge app:build      # regenerate the pair view, type-check, homey app build
noodge app:validate   # homey app validate --level publish
noodge app:run        # run on your Homey
```

### Trying the real doorbell from your computer

The doorbell must not be paired with another controller (including Homey) while you do this.

```bash
noodge spike:discover                      # find it; it should say UNPAIRED
noodge spike:pair --code 123-45-678        # or --code "X-HM://..."
noodge spike:dump                          # services + supported video/audio/SRTP
noodge spike:events                        # press the bell, walk past it
noodge spike:snapshot
noodge spike:record --seconds 10           # then: ffplay -f h264 tools/.data/out.h264
noodge spike:unpair                        # free it again for Homey
```

`tools/.data/` holds the pairing keys and recordings and is git-ignored.

### Store artwork

The app and driver images were generated with OpenAI's image API (`tools/store-art.ts`, prompts included) and cropped to Homey's sizes. The sources are in `tools/store-art/`. The icons are hand-drawn SVGs: the app icon follows `tools/store-art/icon-concept.png`. The generator reads `OPENAI_API_KEY` from `.env`, which is git-ignored and excluded from the app package by `.homeyignore`.

## Verified on hardware (Aqara G4, Homey Self-Hosted Server 13.5.3)

- Pairing with the typed setup code, doorbell presses, motion, battery, 1080p snapshots, writing all seven settings. QR scanning is only tested in a browser harness so far.
- Video is H.264 Main (`4d0033` at 1080p) at about 20 fps. The G4 sends a keyframe about 0.2 s after an RTCP PLI.
- The G4 rejects HAP write-response on SetupEndpoints (`-70405`), so the app writes and then reads.
- UDP from the doorbell reaches the app on Homey's LAN IP, and Homey's go2rtc reaches the app's RTSP port there.
