# Eval Data Provenance — ICDAR 2019 SROIE

## Dataset

- **Name:** `jsdnrs/ICDAR2019-SROIE` (a HuggingFace mirror of the SROIE dataset)
- **Dataset page:** https://huggingface.co/datasets/jsdnrs/ICDAR2019-SROIE
- **Origin:** This data originates from the **ICDAR 2019 Robust Reading Challenge on
  Scanned Receipts OCR and Information Extraction (SROIE)** — the 15th International
  Conference on Document Analysis and Recognition (ICDAR2019). Per the dataset card:
  > "The ICDAR2019 SROIE dataset was originally published by Huang et al. for the
  > 15th International Conference on Document Analysis and Recognition (ICDAR2019)
  > Robust Reading Challenge on Scanned Receipts OCR and Information Extraction (SROIE)."
- **Original competition site:** https://rrc.cvc.uab.es/?ch=13 (downloads: https://rrc.cvc.uab.es/?ch=13&com=downloads)
- **Citation:**
  > Huang, Zheng and Chen, Kai and He, Jianhua and Bai, Xiang and Karatzas, Dimosthenis
  > and Lu, Shijian and Jawahar, C. V. "ICDAR2019 Competition on Scanned Receipt OCR and
  > Information Extraction." 2019 International Conference on Document Analysis and
  > Recognition (ICDAR), IEEE, 2019. DOI: 10.1109/ICDAR.2019.00244

The mirror provides the Task 3 (Key Information Extraction) ground truth as an
`entities` struct with exactly the four fields **company, date, address, total** —
matching the SROIE task 3 specification.

## License / Terms (quoted exactly from the source)

The dataset card declares the license as **CC-BY-4.0** (`license: cc-by-4.0` in the
README YAML front matter). License URL: https://creativecommons.org/licenses/by/4.0/

From the repository's `NOTICE` file (verbatim):

> This NOTICE file provides attribution and modification information for material
> included in this repository that is licensed under the Creative Commons Attribution
> 4.0 International Public License (CC-BY 4.0).
>
> The following material incorporated into this repository is derived from a work
> licensed under CC-BY 4.0:
>
> Title: ICDAR 2019 Robust Reading Challenge on Scanned Receipts OCR and Information
> Extraction (SROIE)
> Authors: Huang et al., ICDAR 2019 Robust Reading Challenge Organizers
> Source: https://rrc.cvc.uab.es/?ch=13&com=downloads
> License: Creative Commons Attribution 4.0 International
> License URL: https://creativecommons.org/licenses/by/4.0/
>
> The material identified above has been adapted and modified for use in this
> repository. ... All modifications are made by the maintainers of this repository and
> not by the original creators.
>
> The third-party material is provided under CC-BY 4.0 on an "AS-IS" basis, without
> warranties of any kind, consistent with the disclaimer provisions of that license.

CC-BY-4.0 permits use, sharing, and adaptation (including commercial) provided
appropriate attribution is given. Attribution is satisfied by the citation and source
links above; retain this file when redistributing these samples.

## Samples committed

- **30 samples** (target met; well above the 15 minimum).
- Taken from the dataset's **test** split, in order (offset 0–29).
- Total on-disk size: ~4.6 MB.

## File naming pattern

Each sample is a pair keyed by the original SROIE receipt id:

- `<id>.jpg`  — the receipt image (JPEG)
- `<id>.json` — the ground-truth key-information-extraction entities

Example ids: `X00016469670`, `X51005200931`, `X51005433518`.

## Ground-truth JSON structure

Each `.json` file is a flat object with exactly four string keys:

```json
{
  "company": "OJC MARKETING SDN BHD",
  "date": "15/01/2019",
  "address": "NO 2 & 4, JALAN BAYU 4, BANDAR SERI ALAM, B1750 MASAI, JOHOR",
  "total": "193.00"
}
```

Notes for the scorer:
- All four values are strings (never null — empty string used if a field were absent,
  though all 30 committed samples have all four populated).
- `date` is in the receipts' original format (mostly `DD/MM/YYYY`, but formats vary
  across receipts as they reflect what is printed).
- `total` is a numeric string; some receipts include a currency symbol (e.g. `$8.20`)
  while most are bare (e.g. `193.00`). Normalize before numeric comparison.
- `company` and `address` are uppercase as printed on the receipts.

## Download method

No `git`, no HuggingFace `datasets` library, and no `pip` were used (pip was
unavailable in this environment). Data was pulled with Python `requests` against the
public HuggingFace **datasets-server** REST API:

1. Rows + ground truth fetched from:
   `https://datasets-server.huggingface.co/rows?dataset=jsdnrs/ICDAR2019-SROIE&config=default&split=test&offset=<n>&length=10`
   — the JSON response includes each row's `entities` (company/date/address/total) and a
   signed `image.src` URL.
2. Each `image.src` URL was downloaded and written to `<id>.jpg`.
3. The `entities` object was written verbatim (mapped to the 4 keys) to `<id>.json`.

Fetched on 2026-07-10.
