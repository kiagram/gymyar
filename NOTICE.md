# Third-party notices

GymYar — Copyright (C) 2026 kiarash.
GymYar's own code is licensed under the **GNU AGPL v3.0** (see [LICENSE](LICENSE)).

## Derived from openGym

GymYar is a derivative work of **openGym** — Copyright (C) 2026 Duarte Santos, licensed
under the GNU AGPL v3.0. Canonical upstream: <https://gitea.com/DuarteSantos/openGym>.
All notices below are inherited from openGym and remain in force for the parts of this
codebase derived from it, including the App Store additional permission.

## App store exception

As an additional permission under section 7 of the AGPL v3.0, the copyright holder permits
distribution of the openGym mobile application through app store platforms (such as the
Apple App Store and Google Play) whose terms of service would otherwise be incompatible
with the AGPL, provided the corresponding source code remains available under the AGPL at
the project repository. This permission applies to the distribution channel only and does
not otherwise limit the license.

> Inherited by GymYar: an additional permission granted under AGPL section 7 travels with the
> code to downstream works unless it is explicitly removed. It is not removed here, and the
> condition attaches to us in turn — GymYar's corresponding source stays available under the
> AGPL at its own repository.

## UI typeface

The interface is set in [**Vazirmatn**](https://github.com/rastikerdar/vazirmatn) by Saber
Rastikerdar, bundled at `apps/client/src/assets/fonts/vazirmatn-variable.woff2` and used under
the **SIL Open Font License 1.1**, reproduced at `apps/client/src/assets/fonts/OFL.txt`. The
file is the project's own `Vazirmatn[wght].woff2` variable build, renamed only because square
brackets are not safe in a URL; the outlines are unmodified.

Under the OFL the font may be bundled and redistributed with this application, including in
the app-store builds. The licence's one hard condition is the Reserved Font Name: a *modified*
version may not be distributed under the name "Vazirmatn". Nothing here modifies it, so the
name stays — but that is the line to respect if the font is ever subset or re-hinted.

## Body diagram geometry

The muscle outlines the body maps are drawn from (`apps/client/src/lib/body-paths.js`) are derived
from [**MuscleMap**](https://github.com/melihcolpan/MuscleMap) by Melih Colpan, used under the
**MIT License** and reproduced below. MuscleMap ships its path data as Swift source rather than
`.svg` files; the paths were converted to a JSON module, its sub-group shapes were dropped, and
nothing else about the artwork was changed.

```
MIT License

Copyright (c) 2026 Melih Colpan

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

## Exercise data & media

The exercise names, instructions (English in `packages/domain/src/exercises-data.js`, other
languages in `apps/client/src/instr/`, regenerated via `infra/scripts/build-instructions.mjs`), images
and animations (fetched into `media/` at build time) come from
[**hasaneyldrm/exercises-dataset**](https://github.com/hasaneyldrm/exercises-dataset)
and are **not** covered by openGym's AGPL license — they remain under that dataset's own terms.
The media files are not distributed in this repository; they are downloaded from the upstream
source on first run. If you redistribute openGym with the media included, review the upstream
license first.
