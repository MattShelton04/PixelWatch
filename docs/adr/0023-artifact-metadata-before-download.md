# ADR 0023: Artifact metadata selection before download

- Status: accepted (implementation inference under ADR 0014)
- Date: 2026-10-03
- Task: M2.3 source ingestion

## Context

The real forge returns authenticated API artifact descriptors, but the core selection type
required ZIP bytes although selection only examines names and IDs. Downloading everything
would open unrelated and duplicate parts. Passing only successful downloads would erase
duplicate and ignored diagnostics; dummy empty archives would invent received parts.

## Decision

Make the existing selector generic over `ArtifactMetadata`, preserving original descriptor
identity for the forge's authenticated download port. Its classification and ordering rules
stay unchanged. `ArtifactInput` extends metadata with ZIP bytes.

Add optional `IngestInput.listedArtifacts`: the complete API metadata listing. In this mode,
downloaded archives must each match one uniquely selected descriptor by exact ID/name and
may appear only once. Refuse inconsistencies with `ingest-selection-invalid` before reading
any ZIP, decoding or staging blobs. Preserve true duplicate/ignored metadata; a selected
artifact whose download is unavailable remains not received, with unknown catalog size.
No synthetic archive, source envelope or write target is introduced.

## Consequences

Existing callers supplying all archives keep their behavior. Source ingestion can select
before download without duplicating selection logic. Missing-download reasons remain fixed
publisher diagnostics; the core never infers zero units from missing bytes. No schema,
canonical golden, comparator policy or dependency changes. This seam is not a working
ingest job or evidence for the still-unavailable full pipeline scenarios.
