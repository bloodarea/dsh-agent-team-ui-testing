# Scene specification data modules

Import the public module surface from `./index.js`. These modules perform deterministic data work and produce plans; they never execute Blender, Python, shell commands, model code or arbitrary script paths. The formal Draft 2020-12 schema is supplied by `schemas/blender/scene-specification/1.0.0.schema.json` through `tools/blender/schema.js`.

## Validation and canonical data

- `parseStrictJson(text, limits?)` rejects duplicate members (including escaped spellings), non-finite numbers, invalid Unicode and invalid JSON syntax. Defaults: 8 MiB UTF-8, nesting 64, 200,000 nodes, strings 1 MiB. Use raw `sceneJson` / `patchJson` when duplicate-key detection is required. Object input has already lost any original duplicate members.
- `canonicalize(value)` and `hashJson(value)` implement JSON Canonicalization Scheme ordering and ECMAScript numeric serialization, rejecting cycles, accessors, sparse arrays, custom prototypes, non-JSON values and lone surrogates. `sha256(bytes)` hashes raw bytes.
- `validateScene(scene, {tombstones?})` and `validatePatch(patch)` return `{valid,errors}`. `assertScene` / `assertPatch` throw `SpecError` on failure. Semantic errors contain `code,instancePath,relatedIds,expected,actual`. Schema errors retain their instance paths and fail closed if the schema validator dependency is missing.
- Semantic checks cover ID resolution, slot/claim bijection, parent and evidence cycles, assembly membership, direct provenance, review evidence, image rectangles, expected resource kinds/channels, geometry classification, quaternion/normal normalization, ordered depth ranges, reference frames, traceable metric scale and conflicting hard dimension intervals. Artifact bytes and pixel registration are checked separately at store admission. A valid specification alone does not prove measured geometry, calibrated camera accuracy or successful Blender application.

## Authorization and artifact storage

Construct `new ArtifactStore({rootDir,authorize,now?,maxBytes?})`. Every call requires `workspaceId` and the actual Host `actor`. The async Host callback receives `{...request,action}` and must return exactly `true`; omission denies access. `put` additionally requires a Host `grantId`. The Host is responsible for authenticating the actor, checking grant scope, expiry and replay policy; these libraries never accept `patch.author` as an authorization identity.

- `put({workspaceId,actor,grantId,bytes,mediaType,sha256?,metadata?,retentionUntil?})` returns `{artifactId,sha256,mediaType,byteLength,retentionUntil,metadata}`.
- `get({...context,artifactId,sha256?})` / `resolve(...)` return the descriptor plus `bytes`. They do not expose filesystem paths.
- Artifact IDs are deterministic from the content SHA; the full 256-bit digest and length are always checked. A truncated-ID collision is rejected. Bytes are shared by digest; immutable descriptors and permissions are isolated by workspace. Retention defaults to 30 days and is enforced on every read. Re-putting identical content does not extend the original immutable retention record. Explicit conflicting metadata is rejected; omitted metadata reuses the existing descriptor.
- Source references must resolve in the caller's workspace. `referenceImage` must point to PNG with verified dimension metadata. Raster products additionally require channel, encoding and alignment metadata with a source digest and `derivedToSource`; authorization and SHA checks precede access. Decoder/worker admission must create trusted metadata; arbitrary caller assertions are not a substitute for decoding.

## Durable SpecStore

Construct `new SpecStore({rootDir,authorize,artifactStore?,now?})`. If omitted, an ArtifactStore is created below the same root. Actions passed to authorization are `spec:create`, `spec:commit`, `spec:read`, `spec:audit` and artifact actions.

```js
const context = { workspaceId, actor: authenticatedPrincipal, grantId };
const receipt = await store.create({ ...context, sceneJson });
const snapshot = await store.get({ workspaceId, actor: authenticatedPrincipal, sceneId });
const next = await store.commit({ ...context, patchJson });
const history = await store.listRevisions({ workspaceId, actor: authenticatedPrincipal, sceneId });
```

`create` accepts exactly one `scene`, `sceneJson` or authorized `artifactId` input. `commit` accepts exactly one `patch` or `patchJson`. Receipts contain `sceneId,revision,artifactId,sha256,receiptId`. `get({sceneId,revision?})` also returns the immutable `scene`, authorized receipt and tombstones. `getReceipt` selects by `receiptId`, `patchId` or `revision` and returns audit data. `replay` reapplies the original ordered patches, validates each final state and checks stored snapshot/tombstone digests.

A transaction contains the entire snapshot, original patch, receipt, tombstones and audit together. The file is flushed before exclusive hard-link publication to the revision filename. That atomic, no-overwrite link is the cross-process CAS point. Local filesystem support for hard links and file flushing is required; network/object filesystems are unsupported. Directory flush is performed where supported (Windows Node does not expose a portable directory-flush guarantee). Process crashes before publication leave only ignored `.pending-*` files; crashes after publication leave a complete transaction. Power-loss durability also depends on the host filesystem's persistence guarantees. Unreferenced temporary/blob files can remain after interruption; garbage collection is not provided by this module.

New scenes start at revision 1. Identical canonical create returns the original receipt. Commit checks canonical `(sceneId,patchId)` replay before baseline CAS; changed content under the same ID is `PATCH_ID_CONFLICT`. Whole-record operations run on a detached copy, may forward-reference additions in the same patch, and are validated only in their final state. Deleted IDs are permanently tombstoned, including remove/add within one patch. Sources/evidence are append-only. A failed commit leaves the previous revision visible. `beforePublish` is a test-only constructor hook for fault injection.

## Builder and patch helpers

`new SpecBuilder(sceneOrSceneId,{tombstones?})` exposes a detached `.scene` for structural assembly, plus `addSource(id?,record)`, `addEvidence(id?,record)`, `ensureClaim(target,value,meta)`, `setSlot(pointer,claimId)`, `buildSnapshot()` and `buildPatch(baseRevision,ops?,meta)`.

Existing claim IDs are reused by target. New IDs derive from the normalized pointer slug and SHA suffix, extending the digest on collision or tombstones. `ensureClaim` writes its slot automatically. Pass `{status:'unknown',reason}` for unknown values or `{status:'candidates',origin,evidenceIds,...}` with a candidate array. `buildPatch` can diff the Builder's original snapshot or accept explicit operations; metadata requires `author,reason` and accepts an explicit `patchId`. The standalone `buildPatch(scene,baseRevision,ops,meta)` and `applyPatch(scene,patch,{tombstones?})` use the same validators as storage.

## Controlled compiler

`compileScene(scene,{binding,previousScene?,managedState?,segments=32,blenderUnitScaleLength=1})` returns a pure, hashed plan. `binding` requires `{targetId,generation,sceneRevision}` independently of the specification revision. `previousScene` enables explicit managed-object deletion plans. A managed-state record uses `{stableId,sceneId,managedBy:'dsh-agent',inManagedCollection:true,contentHash,actualContentHash,unmanagedChildren?,externalUsers?}`; absent ownership proof blocks deletion, and mismatched/duplicate state blocks modification.

Only `collection.ensure`, `object.ensure`, `object.parent`, `object.transform`, `mesh.primitive`, `object.remove`, `material.ensure` and `material.assign` are emitted. Primitive coverage is box/cylinder/frustum. Ops contain `{id,opId,args,instancePath,dependsOn,permissions}` and are ordered by dependency. Metric lengths and translations multiply `metersPerUnit / blenderUnitScaleLength`; scales, colors, quaternions and scores do not. `segments` is a bounded implementation parameter included in both op args and plan hash.

Unknown/candidate/rejected values never become zeros or guessed material values. Their exact pointers and unblocked steps appear in `unresolved`. Structural placeholders are explicit in `assumptions`. Pending claims carry provenance and mark the plan provisional; application needs a human grant bound to `planHash`. Deletion adds `scene:delete-managed` and one-time approval permissions. Cameras, non-first-batch geometry, material deletion, unmapped fields, multi-material face assignments and evidence-only relation/surface/depth/constraint work are explicitly reported. No plan is an execution authorization. The Host must recheck target generation, engineering baseline, leases, permissions, grants and ownership at apply time, then independently read back Blender results.

## CPU reference baseline

`normalizeReferenceImage(bytes,{frameIndex?})` fully checks PNG chunk CRCs, image dimensions, compressed stream boundaries and decoded byte count. The dependency-free baseline supports non-interlaced 8-bit RGB/RGBA PNG and emits deterministic sRGB RGBA PNG while preserving alpha. ICC, EXIF, animation, palette/grayscale/transparency variants and other formats return `ALGORITHM_UNAVAILABLE`; they require a registered decoder. Untagged PNG uses an explicit reported sRGB assumption. Limits are 32 MiB compressed, side 8192, area 24 MP. Run substantial decoding in the Host's bounded worker, rather than its UI loop.

`createRoiMapping({widthPx,heightPx,rectPx?,outputWidth?,outputHeight?,contentRect?})` records both 3×3 row-major maps and actual content bounds. `mapPointToSource` / `mapPointFromSource` preserve subpixel positions; padding and out-of-ROI points are rejected. `mapRectToSource` intersects actual content, maps all corners, rounds outwards and clips to source bounds. These helpers describe mapping and resampling policy; they do not perform image resizing.

Run the standalone CPU acceptance suite with `node --test tests/acceptance/blender-spec.mjs`.
