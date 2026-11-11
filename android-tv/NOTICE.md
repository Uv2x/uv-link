# Uv Link TV app: licenses and credits

The Android TV app in this folder is licensed under the **GNU General Public License v3.0**
(see [LICENSE](LICENSE)), because its AirPlay receiver contains FairPlay code that descends from
GPL-licensed projects. The rest of the Uv Link repository (PC app, web app) is not covered by
this file.

## Code from other projects

**java-airplay** by Sergei Fedorov, https://github.com/serezhka/java-airplay (MIT License)

- `app/src/main/java/com/uvlink/tv/airplay/fairplay/*.java` and the FairPlay tables in
  `app/src/main/resources/com/uvlink/tv/airplay/fairplay/` (changed: package name, table loading,
  `FairPlayHandshake` takes and returns byte arrays).
- Test data in `app/src/test`: the captured iPhone FairPlay session in `IphoneCapture.kt` and
  `mirror_packet_iphone.bin`.

```
MIT License

Copyright (c) 2022 Sergei Fedorov (serezhka@xakep.ru)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

That FairPlay code is a Java port of **PlayFair** by EstebanKubata
(https://github.com/EstebanKubata/playfair, GNU GPL), which RPiPlay and UxPlay also use.

**Apple Lossless (ALAC) decoder**, Copyright (c) 2011 Apple Inc., https://github.com/macosforge/alac
(Apache License 2.0, http://www.apache.org/licenses/LICENSE-2.0)

- `app/src/main/java/com/uvlink/tv/airplay/AlacDecoder.kt` is a Kotlin port of the decoding parts of
  the reference code (ALACDecoder.cpp, ag_dec.c, dp_dec.c, matrix_dec.c).

## Protocol references

The rest of the AirPlay receiver (`app/src/main/java/com/uvlink/tv/airplay/*.kt`) was written for
Uv Link, following how **UxPlay** (https://github.com/FDH2/UxPlay, GPL-3.0) and java-airplay
handle the AirPlay mirroring protocol: mDNS records, /info, pairing, SETUP, the mirror and audio
streams. AirPlay, iPhone and iPad are trademarks of Apple Inc.; Uv Link is not affiliated with Apple.
