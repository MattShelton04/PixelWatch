# PngSuite (third-party test images)

The PNG test suite by Willem van Schaik, release 2017-07-19, unmodified. It is used only by
`packages/core/test/png-decode.test.ts` (07 §2: cross-check the decoder against the PNG test
suite, in the test toolchain only). The licence is in [`LICENSE`](LICENSE).

- Source: `http://www.schaik.com/pngsuite/PngSuite-2017jul19.tgz` (the site serves no working
  HTTPS). Archive SHA-256:
  `0294b244c95a8342c01b00010cf34abdcabc7c6a34fd0fe1bd963917537bfdc8`. Fetched 2026-10-01.
  As a spot check, `basn2c08` and `basn6a08` decode to the same pixels as the copies in
  libpng's `contrib/pngsuite` fetched over HTTPS.
- Every `.png` from the archive is here. `PngSuite.README` is left out (it only lists the files).

`expected.json` gives the trusted decoder's expected outcome for each file. It was derived from
the PngSuite naming convention, the suite's description of the corrupt `x*` files, and the chunk
types each file contains, not by running the decoder. The first failing check wins: signature,
chunk framing and CRC, IHDR fields (colour type, then bit depth, then interlace), then chunks
other than IHDR, IDAT and IEND. Only 10 files fit the restricted profile as they are. The test
also strips ancillary chunks with the converter-side `normalizePng` (as a capture-side
converter would) and cross-checks every file that then fits.
