# Play submission

Package: com.cjber.kiln. Target API: 36. CI builds bundleRelease; tagged releases sign kiln-android.aab with the existing APK signing key.

## Signing

Enrol in Play App Signing using the existing signing key if Play and GitHub installs should update one another. Do not let Google generate an unrelated key for that case. Follow Google's key-import flow in Play Console. A separate upload key can then be configured. Private keys and passwords stay outside the repository.

Local bundle build:

    ANDROID_HOME=/opt/android-sdk JAVA_HOME=/usr/lib/jvm/java-21-openjdk android/gradlew -p android bundleRelease

The local bundle is unsigned. Upload the signed AAB from a tagged release. Every later upload needs a higher versionCode; prepare versions with scripts/release.ts.

## Reviewer instructions

The app has restricted paired-machine functionality. Open kiln and select “Try an offline demo” to explore clearly labelled samples without credentials. Open the Codex sample, answer its permission request, send a sample prompt, return to the list, search/filter and hide/restore samples. This is a simulation, not access to live agents.

Live functionality still requires a computer and agent. If Google requests live review access, provide an isolated demonstration machine over public HTTPS with reusable access. Do not expose personal sessions or production credentials. Ordinary invitations expire after five minutes and are single-use, so they are unsuitable for unattended review access.

## Data safety draft

Do not answer “no data collected”. Google's scanner SDK collects diagnostics even though kiln has no central conversation service.

| Flow | Suggested category | Purpose and handling |
| --- | --- | --- |
| Prompts and conversation content sent to the selected machine | Other user-generated content | App functionality; prompts optional; retention controlled by machine/provider, not ephemeral |
| Phone model sent during pairing | Confirm applicable device-information category | App functionality; identifies the paired phone |
| Scanner installation/device identifiers | Device or other IDs | Google SDK diagnostics and analytics |
| Scanner performance/errors | Diagnostics, other app performance data | Google SDK diagnostics and analytics |
| Scanner feature events | App interactions | Google SDK analytics |

Review this draft against the current form and SDK documentation before certifying it. SDK diagnostics may run during initialization; do not mark data optional solely because scanning has a button. User-initiated transfers to selected services may meet Google's sharing exception; collection and sharing are separate questions. Do not claim end-to-end encryption or independent security certification.

Kiln uses HTTPS, disables cleartext traffic and Android backup, and encrypts local pairing credentials with Android Keystore. It has no kiln user account; pairing is not account creation. Forgetting a machine removes credentials, not provider history. Clearing app storage removes local hidden-session preferences.

Sources:

- https://developers.google.com/ml-kit/android-data-disclosure
- https://support.google.com/googleplay/android-developer/answer/10787469
- https://support.google.com/googleplay/android-developer/answer/15748846
- https://developer.android.com/studio/publish/app-signing

## Owner steps

1. Open Play Console, verify identity/device, and confirm public developer/contact details.
2. Publish the included privacy HTML at a public HTTPS URL and enter it in Play Console.
3. Import the existing signing identity, upload a signed release AAB, and enter listing and Data safety declarations.
4. Complete content rating and intended-audience declarations.
5. For personal accounts created after 13 November 2023, complete the required 12-tester closed test for 14 continuous days, then apply for production access.
6. Submit for review. No upload or production rollout is automatic in this repository.
