# AI Memories Studio · Phase P6.1

A private, local web app that collects two people's explicitly selected Google Photos and prepares a cinematic storyboard. P2's OAuth, Photos Picker, persistent import queue, and virtualized gallery are preserved. P3 adds resumable Gemini photo analysis, two user-confirmed protagonists, diverse curation, and an editable, versioned 120–900-second storyboard. P4 adds individually approved private scene clips and conversational video refinement. P5 assembles private 120–900-second MP4 movies locally from approved clips, original photographs, titles and licensed soundtracks. P6 coordinates these existing services from one explicitly approved full-run workflow.

## Run locally

Use Node.js 24 LTS (recommended), or Node.js 22.13 or newer with built-in `node:sqlite`, and npm. Run these commands from the repository root:

```sh
npm install
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Copy the generated value into `SESSION_SECRET` in `.env`. Fill in the Google client ID and client secret after completing the Google setup below. Keep `.env` private; it is excluded from git. No secret belongs in a `VITE_` variable.

```sh
npm run dev
```

Open [AI Memories Studio](http://localhost:5173). The API listens at [http://localhost:3001](http://localhost:3001), and [GET /health](http://localhost:3001/health) reports readiness. Missing Google credentials leave the dashboard in setup mode; a session secret is still required. Use `localhost` consistently: changing to `127.0.0.1` changes the browser origin and cookies.

## Movie length and soundtrack uploads

Whole movies support **120–900 seconds (2–15 minutes)**, with the existing 150-second default. The same bounds apply to the Director, Movie Studio and automatic production. Individual generated clips keep their existing provider durations; a longer movie uses additional distinct original-photo montage time and does not silently increase paid scene counts or spending approvals. Plans with too little distinct media report capacity limits rather than stretching or repeating generated video.

Choosing a music file is a pending selection, not a completed upload. Confirm your license and click **Save licensed soundtrack**. Uploads are independent of unsaved or invalid movie settings: successful audio is registered privately, appears in the library and is selected in the local movie draft. Other draft settings are preserved. Save movie settings separately before rendering. Instrumental and vocal tracks both work; the instrumental checkbox records your description of the track. Production soundtrack choices refresh when the library changes. Upload failures keep the selected file available for retry, while file/metadata/default selection commit together to avoid ghost tracks. No upload starts a render or paid generation.

## Saved moments now reach manual Movie Studio exports

The manual **AI Director → Movie Studio** route now applies saved Sequence & Storytelling choices to new local renders, as well as the automatic P6 workflow. The optional **Mix saved moments and collages into this movie** setting defaults on when saved moments exist. Owned original-photo slots become deterministic compositions with the selected layouts, order and captions. Eligible pinned originals previously mentioned only in title/source metadata receive real local screen time. Excluded/deselected originals and reference-only pictures stay out of original-photo footage.

Existing approved generated clips keep their exact asset IDs, prompts, source inputs and approvals. Local collage editing never invokes Gemini, never regenerates a clip and never turns an old one-image clip into a multi-image animation. Explicit manual storyboard generation now sends bounded saved-moment context and up to 12 sequence previews in its existing single Gemini request; future generated multi-image scenes still require the normal P4 quote and approval.

Movie Studio shows **compiled** moments, animated collages, montage segments, actual original-photo coverage, text overlays and reused clips. Its timeline displays the real composition thumbnails. Existing MP4s are immutable: after changing storytelling choices, create a new local movie to see those changes. The selected export’s saved revision is compared with the current preview so the app identifies an outdated export accurately.

Migration **8** freezes each new render’s effective local edit plan in `movie_timelines.edit_plan_json`. Layout/caption changes during rendering apply to a future version; ownership, original hashes, exclusions, clip approval and likeness revocation still stop unsafe publication. Original P3 storyboards and prior exports are preserved. Historical timelines without an edit snapshot retain their original local plan.

Collage layers and montage captions are now compiled after final duration/transition/beat allocation. A short draft collage expanded to a longer segment keeps its photos until the final allocated frame; draft layer durations no longer make images disappear early. Provider input counts come from actual approved job inputs, rather than potentially larger legacy provenance arrays.

Run `npm run test:storytelling` for an isolated **390-second 720p** movie through the manual raw API, using 140 synthetic originals, saved moments, local collages, licensed synthetic audio and two previously approved synthetic clips. Every generative method is forbidden in this validation. Outputs and source/timing proof are private under `data/manual-storytelling-validation`. Integration tests also verify immutable snapshots, clip reuse, private access, caption/layout edits and a real 20-second elastic collage with photo pixels checked at the beginning, middle and end.

## P6.1 · Intelligent cinematic direction

The existing P3/P4/P5/P6 services now share a sequence-aware director. **No real movie is regenerated automatically.** Existing storyboards remain readable because the additional scene fields are optional; legacy production configurations without `cinematic` keep their P6 behavior. The working Gemini Omni model, Interactions SDK, authentication, database, private storage and paid-intent queue are preserved.

### Using the director

The optional **Sequence & Storytelling** section groups related imported originals and lets you merge/split moments, reorder photographs, pin/exclude whole moments, choose a presentation or collage layout, preview an animated composition, and edit caption text, timing, language, alignment and effects. Controls paginate moments and use bounded private 320-pixel thumbnail requests. Opening this section and detecting candidates use local metadata only; they never upload photos or start paid work.

**Create My Movie** supports Cinematic, Emotional, Documentary, Travel, Romantic, Minimal and Energetic editing preferences. New default proposals use **6 AI scenes, 1 total retry and a USD 20 maximum**, with target screen-time preferences of **35% original animation / 25% fictional scenes / 20% collages / 12% montages / 8% standalone text**. Percentages are preferences, adjusted for actual sources, clip lengths and the approved budget. Overlay captions do not add standalone time. Previous configurations retain their stored scene counts and retry limits.

The full-run quote remains mandatory before any paid analysis, multimodal sequence reasoning, storyboard, keyframe, video or advisory review. It includes up to two additional chained-pair operations and conservative three-pair retry allowances. This can exceed USD 20; reduce AI scenes/retries or explicitly approve a higher cap. Local collage pixels, typography and FFmpeg assembly incur no AI-generation cost. A smaller generated-motion budget naturally gives originals more screen time.

### Sequence evidence, generation and reuse

`PhotoSequenceAnalyzer` groups reliable EXIF/Google capture timestamps, device evidence, whole-image perceptual continuity and cached visible scene/activity summaries. Upload/import order never establishes chronology. Missing dates, contradictory timezone evidence and manual reversals lower confidence. Exact SHA-256 duplicates are separate from consecutive action frames. Entire moments are ranked before representative photos; both confirmed protagonists, pins, exclusions and visual variety remain relevant. Thematic bundles of independent originals are explicitly labeled as thematic, not asserted to depict one event.

The existing, approved Gemini storyboard request receives bounded sequence summaries and up to 12 resized sequence previews in addition to the confirmed protagonist references. It can refine ambiguous groups, layouts, text and presentation choices through validated structured output. Sequence previews are never identity evidence, and AI cannot upgrade uncertain capture timestamps into verified chronology. User-reviewed choices take priority. No separate unbudgeted reasoning call is introduced.

The installed Interactions schema documents `image_to_video` with an ordered starting image and optional ending image. First/last interpolation uses actual two-image inputs, with the documented **3–10-second** duration restriction. Chained animations persist up to three adjacent pair operations in one P4 job, preserving each operation ID, reservation and downloaded segment before proceeding; local concatenation retains their complete duration. Unordered references use `reference_to_video`, never masquerade as keyframes. The application conservatively supports three references with the unchanged Omni 1.1 configuration and the documented six with Omni 1.2; it does not silently switch models. Model/account access remains unverified until a user-approved live request succeeds. See [official Omni generation and interpolation documentation](https://aistudio.google.com/docs/omni#first-and-last-frame-interpolation) and [Interactions task schema](https://aistudio.google.com/api-reference/interactions-api).

Unsupported or uncertain modes use an explicit local montage/collage and retain every source. When a long action sequence uses selected control frames, its remaining photographs receive supporting local compositions; counted photographs therefore reach either the provider inputs or the rendered originals. Existing generation history is preserved. Exactly compatible, approved P4 clips can be reused after current ownership, consent, original hashes, ordered sources, prompts, settings, model and advisory threshold checks. Conversational refinements are not mistaken for base generations. Unrelated or changed footage is never reused merely because it looks similar. Quotes remain conservative even when compatible clips are later found.

### Local compositions and multilingual text

Deterministic templates cover split screens, three-photo editorial layouts, four-photo grids, six-photo mosaics, eight-photo contact sheets, filmstrips, scrapbooks, before/after comparisons, action grids and travel boards in 16:9 and 9:16. Real originals retain their proportions, with containment or explicit crop, safe margins, separators, rounded masks and restrained entrance, zoom, pan and fade animations. Compositions support ordered graphical/photo/video layers, timed opacity, position/scale keyframes and easing. P5 pre-renders bounded intermediate segments, then applies the existing frame-exact transition math, licensed music, source audio and final MP4 validation. A browser need not stay open.

Narrative overlays support English, Spanish accents and Hebrew RTL using **libvips Pango/HarfBuzz shaping**, not manual string reversal. Fade, slide, reveal/typewriter, scale, lower thirds, photo/collage overlays and standalone cards are deterministic. Main and secondary titles are positioned separately; simultaneous captions are stacked within safe areas. Factual generated captions require exact trusted evidence; user-written text stays editable. Caption placement uses safe-area/lower-third heuristics rather than face identification, so a final visual check is still appropriate. Music onset alignment is local and limited to safe nearby cuts; it is not a full musical beat/tempo analysis.

Migration **7** adds `photo_sequences`, `cinematic_preferences` and immutable `cinematic_production_snapshots` in the existing SQLite database. Private thumbnail files/reservations also persist there and count against the shared P2/P4/P5 storage quota. Source edits invalidate quotes; active or paused runs freeze manual choices and require a new version to change them. All new routes remain behind existing ownership, cookies, Origin and CSRF protection. No public image URLs or biometric identity database is introduced.

### Verification and low-cost manual validation

Run `npm run typecheck`, `npm test`, `npm run build` and **`npm run test:cinematic`**. The last command uses an isolated 140-photo synthetic project, mocked Gemini/video providers, real P3/P4 workers and real P5 FFmpeg rendering. It creates `data/p61-validation/synthetic-cinematic-150s.mp4`, `report.json`, `comparison.json`, `source-evidence.json` and a contact sheet. The report compares previous P6 and P6.1 on the same simulated originals; provider input hashes and renderer source/layer IDs prove multi-image preservation. No personal media or paid API call is used. Automated coverage includes 140/500/1,000 photos, capture-order uncertainty, first/last SDK serialization, chained restart/reservations/unknown outcomes, all layout sizes, portrait/landscape, shaped text, timeline/audio math, ownership, quotas and previous-phase regressions.

`npx tsx apps/api/scripts/p61-compare-local.ts` performs a **read-only metadata comparison** of the current local collection, with no Google requests or asset changes. Unavailable or missing confirmed references produce a readiness block. Movie-excluded photographs may still serve as explicitly approved likeness references; they are never added back to original-photo scenes. Aggregate output is private under `data/p61-validation/local-collection-comparison.json`; it contains no personal descriptions or images. The synthetic report remains the complete executable comparison until the real project is ready.

For a low-cost live check, first confirm two available reference photos and likeness permission for each protagonist, inspect local moment grouping and an animated collage preview, and upload only your own licensed soundtrack if desired. Choose **2 AI scenes**, **0 scene retries** and **0 total retry allowance**, leaving the rest to local originals and compositions. Review the new quote, permissions and maximum spend, then explicitly approve only if you intend to incur those charges. Check one multi-photo animation, two collages, captions (including Hebrew/Spanish where used), opening/closing titles, audio, seeking and download. Review advisory likeness/quality flags. The implementation agent has not run a paid P6.1 end-to-end test.

## P6 · Create My Movie

P6 adds a durable parent workflow around the existing P3 analysis/curation/storyboard, P4 Gemini Omni jobs/advisory quality review and P5 local rendering. It uses the **same SQLite database, original photo storage, SDK, generation provider, workers and authenticated media endpoints**. Earlier studios remain available for manual work. No live paid P6 end-to-end test has been performed by the implementation agent; the synthetic workflow below uses mocked AI and real local rendering.

### One full-run approval

1. Import the photos you explicitly choose in Google Photos. In AI Director, configure both protagonists with names, at least two confirmed reference photos each and likeness permission. P6 ranks references only within those confirmed selections. It never identifies faces throughout the library. Deselected or movie-excluded originals are not used as movie footage. Explicitly chosen, owned protagonist references remain valid for likeness guidance even when excluded from movie inclusion; remove them from the protagonist profile or revoke likeness permission to stop that use.
2. Open **Create My Movie** in the sidebar, or [automatic production](http://localhost:5173/#production-studio). Set title, duration **120–900 seconds** (default 150), cinematic style, emotional tone, generated-scene balance, number of AI scenes, quality threshold, retry allowance, licensed soundtrack, titles, aspect ratio, export resolution and maximum spend. Protagonist names come from the existing confirmed profiles; optional title text does not rename them.
3. Click **Create My Movie** to prepare a free local estimate. This does not analyze photos, submit generation, or upload images to Google. The quote includes every uncached photo analysis, storyboard request, video, fictional keyframe, quality check and conservative retry allowance. It shows models and expected/maximum billable video seconds. Quotes expire after ten minutes; changes to sources, permission, settings, models or prices require review again.
4. Explicitly approve the maximum spend and both affirmations: permission for everyone visible in the selected inputs, and automatic fictional-scene creation/advisory acceptance. Approval authorizes resized selected photographs and confirmed reference copies to be sent to Google Gemini for this workflow. Originals remain local. Opening the app, requesting a quote, or creating an unapproved run never starts paid work.
5. P6 analyzes incrementally, curates diverse grounded sources, creates a validated storyboard, generates one or a bounded number of clips at a time, evaluates quality, uses only the approved bounded retries, and assembles the complete movie locally. Individual scene approvals are automatic under the saved run approval. Fictional scenes and automated decisions are explicitly recorded; advisory appearance consistency is never verified biometric identity.
6. Preview, seek and download the final private MP4. **Regenerate / New version** obtains a fresh estimate and explicit spending approval. Review and override a saved clip to pause the current run; manual approval or rejection takes priority over an older automatic review. Completed/cancelled versions stay immutable: create a new version to change them. Existing P3/P4/P5 tools remain available for direct editing and review.

Legacy P6 configuration defaults were **8 generated scenes**, a **50/50 balance within generated motion**, advisory score threshold **70**, at most **1 retry per scene** and **2 retries across the run**, and a proposed **USD 20** cap. The remaining screen time uses distinct original-photo montages and titles. The ratio is not a claim that all 150 seconds are newly generated video. Increase AI scene count and the approved budget if you want more generated motion. A 720p generation exported at 1080p is upscaled; export resolution cannot recover missing detail. The live quote makes this distinction visible.

### Budget, caching and recovery

Migration **6** adds `production_runs`, `production_quotes`, `production_run_photos`, `production_scenes`, `production_scene_attempts`, `production_render_attempts`, `production_operations`, `production_errors` and a separate fenced coordinator lease. Configuration/approval, frozen selected source IDs/hashes, scene dependencies, P3/P4/P5 child IDs, estimated spending, reservations, safe error history and final export IDs persist. Provider operation IDs continue to live encrypted in the existing P4 job records; no token or remote capability is returned in P6 metadata.

The run states are `DRAFT`, `PREFLIGHT`, `ANALYZING`, `CURATING`, `PLANNING`, `AWAITING_BUDGET_APPROVAL`, `GENERATING`, `QUALITY_REVIEW`, `RENDERING`, `VALIDATING_FINAL_MOVIE`, `COMPLETED`, `PAUSED`, `FAILED`, `CANCELLED`. One open production run per project prevents accidental duplicate work. Application idempotency keys recover child jobs even if a crash occurs before the parent's link is saved. No provider-side idempotency guarantee is claimed. Atomic operation claims also prevent two app processes from submitting the same paid analysis/planning request.

Every potentially billable operation reserves against the approved P6 cap before dispatch. Photo requests are bounded to 8,192 input / 2,048 output tokens; storyboards to 65,536 input / 12,000 output tokens. Free token counting rejects an oversized input before paid submission and permission/state is checked again immediately before the SDK call. Completed responses replay from durable cache. Known rejected rate limits retry with backoff and bounded attempts; unknown timeouts, network/5xx outcomes and incomplete paid checkpoints **pause rather than automatically resubmit**. A saved but expired/unresolved provider operation also pauses before replacement. In-flight work can finish after pause/cancel and may still incur charges.

The existing P3/P4 ledgers record the same child work; their amounts are **not additional charges** to add to the P6 total. A guarded P6 analysis dispatch uses its run cap instead of the unrelated legacy P3 environment ceiling. Run approval allocates sufficient room in the P4 project ledger, while P6's separately enforced cap remains authoritative for that run. Previous project spending and independent manual P3/P4 approvals are not included in the new run's maximum. Unknown spending from an earlier cancelled run requires explicit acknowledgement before a separately approved new version.

Spending based on provider token usage is still an **estimate**, not a confirmed invoice. Observed charges remain null when Google does not report them. With current default configured rates, 8 scenes and 2 retries estimate about **$15.48 when all analyses are cached**, or **$23.06 for 1,000 uncached photos**. These are conservative application ceilings, not a promise of actual pricing. If the proposed maximum is too low, reduce AI scene count/retries, use more stills, shorten the plan alongside fewer generated scenes, or explicitly approve a higher maximum. P6 never silently changes the working provider to a cheaper, unverified model. Rates and the existing model transition are documented in [official Gemini pricing](https://aistudio.google.com/docs/pricing#gemini-omni-1.1-flash) and [Omni documentation](https://aistudio.google.com/docs/omni).

Pins, movie-source exclusions, hashes, confirmed associations, selected references and consent are checked throughout. Reference-only inputs have their hashes tracked separately from the frozen original-photo pool. New imports belong to a later run; the active source list is frozen. Changing a frozen source or consent blocks further work and requires review of a new version. Quality failure retries preserve the rejected version. Missing/unavailable quality review pauses for manual review instead of buying a whole new clip blindly. Previously approved fallback footage is used only when explicitly enabled and only for the same scene; unrelated footage is never substituted. Provider safety/authorization/configuration rejections require action rather than repeated paid attempts.

**Pause** stops new claims/paid stages and holds saved P4 operations; already submitted requests may settle into cache. **Resume** continues the saved approval and checkpoints when their status is known. **Cancel** stops local work, attempts documented provider cancellation and retains completed media/history. **Retry stage** respects remaining approved limits; local FFmpeg retries reuse existing source clips. Ambiguous paid requests cannot be restarted through Retry/Resume: wait for a durable result where supported, or cancel and explicitly approve a separate version acknowledging possible prior charges. A verified export is only marked complete after final format/duration and current clip approvals are rechecked.

Private generated clips and movie exports can be deleted by their owner from the workflow. Cancel active dependent generation/rendering first. Original Google Photos are not deleted. Billing/job history remains for reconciliation; deleting an export does not erase provider expenses. Files, fixture databases and all validation artifacts stay gitignored; P2 ownership, cookies and CSRF requirements apply to all P6 endpoints.

### Configuration and verification

Existing P3/P4/P5 model, concurrency, storage and FFmpeg limits remain in effect. New optional settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PRODUCTION_DEFAULT_BUDGET_USD` | `20` | Initial suggested run maximum; user must approve it |
| `PRODUCTION_POLL_INTERVAL_MS` | `1000` | Local parent-workflow polling interval |
| `PRODUCTION_MAX_STAGE_ATTEMPTS` | `2` | Planning-stage bound, also constrained by the approved retry allowance |

Run `npm run typecheck`, `npm test`, `npm run build`, and **`npm run test:production`**. The last command runs a separate synthetic project: 100 generated local photos, mocked analysis/storyboard/video/keyframe/quality providers, the real existing P3/P4 workers and real P5 FFmpeg rendering. It never reads personal media or calls Google. Its output is `data/p6-validation/synthetic-production-150s.mp4`; `report.json` distinguishes requested-but-mocked model names, operation counters, state history, estimates, zero paid calls and actual output properties. Tests also cover 100/500/1,000 photos, cap exhaustion, unknown outcomes, rate limits, quality retry bounds, restarts, cancellation/resume, private access and earlier-phase regressions.

For manual paid validation, review the current real project's full-run quote, approve only a maximum you intend to spend, observe stage/scene progress, and inspect the final movie and its download. Exercise pause/resume with known operations and inspect quality flags; do not assume the passing synthetic workflow proves live provider access, visual likeness consistency or a successful paid end-to-end run.

## P5 local automatic movie assembly

P5 uses **local FFmpeg/ffprobe only**. Creating or retrying a movie never requests a Gemini keyframe, video, analysis or quality review. The existing manual P4 spending approvals remain separate; the P6 workflow above coordinates paid scene generation before invoking this local renderer.

### Create a movie

1. Open **Movie Studio** from the sidebar, or [open it directly](http://localhost:5173/#movie-studio). Save storyboard edits first. P1–P4 screens and generated source files are preserved.
2. Review the readiness checklist. Each `ORIGINAL_ANIMATION` and `NEW_CINEMATIC_SCENE` requires a **completed, approved P4 clip from that saved storyboard**, with current source/reference permission. Missing or rejected clips block the render and show their exact scene IDs. P5 never substitutes an unapproved clip or a photograph for required AI footage. Titles and photo montages use their existing storyboard sources.
3. Set the target to **120–900 seconds**, default **150**. Inspect the calculated timeline, source thumbnails, transition overlaps and actual available motion. Approved clips can be trimmed, never stretched, frozen or looped to fill a gap. Distinct montage photographs receive gentle Ken Burns motion with 3–8 seconds per image; titles receive 2–8 seconds. If that capacity cannot fill the target, the checklist explains the additional media needed. If too many photographs cannot fit at the minimum safe duration, revise the storyboard or increase the target. Chronology and source order are preserved.
4. Optionally upload a **licensed MP3, WAV or M4A** and explicitly confirm permission to use it. Declare whether it is instrumental. A suitable new instrumental upload is selected by default when no track is selected. You may choose no soundtrack. The app does not download music, and states clearly when an export contains only scene audio or silence. Original filenames are display metadata; stored filenames are generated UUIDs.
5. Configure the opening title, optional names/dates, per-scene chapter titles, closing credits, typography/color and optional fictional-scene end disclosure. Text comes from your settings or existing storyboard titles; P5 invents no names, places, dates or events. Unicode text uses locally installed font shaping; custom Unicode fonts can be configured below.
6. Choose **1080p or 720p**, **16:9 or 9:16**, encoding preset/quality, music volume, and whether to retain scene audio. Save settings, then click **Create Movie**. This is local rendering, not paid generation. Progress reflects completed preparation, scene assembly and actual FFmpeg output time where available. Cancellation terminates local child process groups and preserves source clips. A failed render can be retried with the same saved timeline if its sources remain valid.
7. Watch the private HTML5 player or download the MP4. Versions remain in render history. The output uses H.264, 30 FPS, square pixels, YUV420P, AAC stereo 48 kHz and MP4 faststart. When no audible input exists, its AAC track is silent; that is not represented as added music.

### Rendering, transitions and audio

Inputs are checked before processing. Each video is normalized for resolution, frame rate, sample aspect, timestamps and rotation, with aspect-preserving letterboxing. Clips with and without audio work together. Pairwise boundary rendering limits the number of simultaneous video decoders; private intermediates are concatenated without encoding the whole growing movie repeatedly. Incoming transition overlaps are calculated in 30-FPS frame units and subtracted exactly from total source time. Restrained defaults mix clean cuts, crossfades and fades to black; explicit crossfade/fade-to-black/dip-to-white modes are available.

Audio is prepared locally, normalized before user volume gain, trimmed or smoothly crossfaded into loops, faded at the ends and mixed with optional scene audio. Scene audio ducks background music automatically. Final limiting and measured true-peak validation guard against clipping. Local RMS onset analysis attempts small beat-aware shifts only between adjacent elastic still/title segments; it never reorders scenes or alters video integrity. This is onset assistance, not a promise of musical beat tracking. No soundtrack means no background music is added.

The completed MP4 is probed and fully decoded before publication. Validation checks duration tolerance, dimensions, 30 FPS, H.264/AAC, readable audio/video and faststart. A partial or truncated file cannot become a completed export. Fictional scene IDs are retained in project export metadata even if the optional visual disclosure is disabled.

### Persistence, privacy and limits

Additive SQLite migration **5** adds `movie_render_jobs`, `movie_render_assets`, `movie_timelines`, `movie_soundtracks` and `movie_render_settings`, plus a fenced worker lease and shared storage ledgers. A render captures immutable settings and a deterministic timeline. Application idempotency and a unique active-project constraint prevent simultaneous duplicate creation. One local movie job runs at a time. Jobs use the states `PENDING`, `VALIDATING`, `PREPARING_MEDIA`, `COMPILING_TIMELINE`, `RENDERING`, `VALIDATING_OUTPUT`, `COMPLETED`, `FAILED`, `CANCELLED`.

After interruption, the worker discards incomplete temporary outputs and rerenders the saved local timeline. It never claims an unfinished output succeeded. Persisted process IDs are only killed after verifying the unique job workspace in their command line; completed media and source clips are preserved. Pending final-file IDs and workspace reservations survive crash windows so unpublished outputs can be cleaned safely. Abandoned soundtrack uploads are reconciled using their writer process and bounded upload lifetime. Approval, source hashes and likeness permission are checked again before publication; changed sources require review and a new render.

Files live under `data/imports/{projectId}/movies/`; temporary workspaces use its private `.work` directory. Files, SQLite and all validation artifacts are gitignored. Every metadata, soundtrack, playback, range and download endpoint checks the workspace owner. Mutations require the existing Origin/CSRF protection. The API accepts opaque IDs, never arbitrary paths or media URLs. Uploaded audio is streamed with a byte cap and validated by magic bytes, fixed demuxers and restricted protocols before probing, preventing a renamed playlist from fetching external content.

| Variable | Default / purpose |
| --- | --- |
| `MOVIE_THREADS` | `2`, FFmpeg CPU threads (1–8) |
| `MOVIE_MEMORY_LIMIT_MB` | `1024`, monitored per-process RSS and maximum allocation bounds |
| `MOVIE_MAX_WORKSPACE_BYTES` | `4294967296` (4 GiB), reserved temporary-workspace ceiling |
| `MOVIE_MAX_OUTPUT_BYTES` | `1073741824` (1 GiB), final movie limit |
| `MOVIE_MAX_SOUNDTRACK_BYTES` | `104857600` (100 MiB), streamed upload limit; at most 20 minutes |
| `MOVIE_RENDER_TIMEOUT_MS` | `3600000` (one hour), whole-render and child-process timeout |
| `MOVIE_DURATION_TOLERANCE_SECONDS` | `0.15`, output validation tolerance |
| `MOVIE_FONT_SERIF_PATH` / `MOVIE_FONT_SANS_PATH` | Optional absolute paths to Unicode fonts; otherwise OS fonts |

The existing `FFMPEG_PATH`, `FFPROBE_PATH`, `STORAGE_QUOTA_BYTES` and `MIN_FREE_DISK_BYTES` also apply. Photos, P4 clips, soundtracks, movie exports and in-flight reservations share the quota. Preflight reserves the workspace ceiling, and active rendering checks actual workspace size and free disk. RSS/disk checks terminate processes that exceed limits; these local process monitors are not an OS container sandbox. Lower preset/quality or raise a limit explicitly when a legitimate job exceeds it. No source is deleted to make room automatically.

### P5 verification and manual checks

Run `npm run typecheck`, `npm test`, `npm run build`, and **`npm run test:movie`**. The last command builds and fully validates a completely synthetic **150-second 1920×1080/30-FPS movie**, using local test patterns, synthetic audio, photographs and Unicode titles. It requires no Google authorization or API key and makes no paid calls. Its private outputs are `data/p5-validation/synthetic-150s.mp4`, a thumbnail and `report.json` containing measured properties, timing, loudness and fictional-scene metadata. This test does not use personal photos or alter the real storyboard.

Automated coverage includes two and twenty clips, mixed resolutions/frame rates, silent clips, still photographs, Unicode titles, soundtrack volume/fades/looping/ducking, all transition types, duration mathematics, malformed media, cancellation, restart recovery, disk limits, approval/consent changes, private API access, upload licensing and P1–P4 regressions. Provider stubs reject any accidental generation call.

Manual verification: play the synthetic export and inspect titles/transitions/audio; then finish the actual project's readiness checklist, approve every required P4 clip in that saved storyboard, choose your licensed track and titles, create the movie, play it through the authenticated player, seek and download it, and inspect the beginning/end and credits. Existing approved P4 clips are reused automatically. Missing clips continue to block the actual project; P5 never spends money to create them.

## P4 scene clips and controlled paid validation

**No paid P4 generation is run by installation, opening the app, or automated tests.** An authenticated cost quote and an explicit **Approve cost and generate** action are required for every new clip or refinement. A saved storyboard is not spending approval. Existing Google Photos authorization does not approve video spending.

### Current provider and configuration

The implementation uses the official Google GenAI SDK **Interactions API**, with `VIDEO_PROVIDER=omni` and the user-selected `OMNI_MODEL=gemini-omni-1.1-flash`. Google now documents **1.2 as GA**, while 1.1 remains in a transition window and routes to 1.2 from December 3, 2026. Free model metadata checks did not establish this account's Omni access, so the app keeps 1.1 instead of silently upgrading. Both identifiers have separate documented pricing and are allowlisted. **Actual paid model access is unverified until an approved validation succeeds.** See [Omni documentation](https://aistudio.google.com/docs/omni), [model information](https://aistudio.google.com/docs/models/gemini-omni-flash), and [pricing](https://aistudio.google.com/docs/pricing#gemini-omni-1.1-flash).

The requested `veo-3.1-fast-generate-preview` was retired from the Gemini API on **October 22, 2026**. `VeoProvider` remains a modular, explicitly unavailable adapter for a future Google Cloud integration. Selecting `VIDEO_PROVIDER=veo` blocks before any paid request and explains the migration. No Veo request fields are mixed into Interactions calls. See [Google's retirement notice](https://aistudio.google.com/docs/video).

P4 currently supports **720p**, **16:9 or 9:16**, **3–10 seconds**, and **native audio**, with **8 seconds / 16:9** as the initial setting. These are conservative application-supported combinations within a 65,536-output-token ceiling; Google's newer model supports additional combinations that this implementation does not advertise as verified. `VIDEO_RESOLUTION=1080p` is rejected before approval. There is no unsupported provider mute flag. A P3 scene's estimated movie duration is separate from the generated clip's duration.

Use the existing server-only `GEMINI_API_KEY`; enable the appropriate Gemini paid-tier access and quota in its project. Never expose it as a `VITE_` variable. Two-step cinematic scenes use the documented image-generation model `gemini-3.1-flash-image` through `models.generateContent`; the video step uses Interactions. This is a separate image request, not a Veo/reference-image parameter mixed into a video request. Quality review uses `gemini-3.5-flash-lite` with strict, advisory JSON output.

| Setting | Default |
| --- | --- |
| `VIDEO_PROVIDER` | `omni` |
| `OMNI_MODEL` | `gemini-omni-1.1-flash` |
| `VIDEO_DURATION_SECONDS` | `8` |
| `VIDEO_RESOLUTION` | `720p` |
| `VIDEO_ASPECT_RATIO` | `16:9` |
| `VIDEO_MAX_CONCURRENT_JOBS` | `1` |
| `VIDEO_MAX_PROJECT_BUDGET_USD` | `10` |
| `VIDEO_MAX_AUTOMATIC_RETRIES` | `1` |
| `VIDEO_POLL_INTERVAL_MS` | `10000` |
| `VIDEO_REQUEST_TIMEOUT_MS` | `60000` |
| `VIDEO_MAX_BYTES` | `536870912` (512 MiB) |
| `VIDEO_KEYFRAME_MODEL` | `gemini-3.1-flash-image` |
| `VIDEO_QUALITY_MODEL` | `gemini-3.5-flash-lite` |
| `VIDEO_KEYFRAME_ESTIMATE_USD` | `0.25` |
| `VIDEO_QUALITY_ESTIMATE_USD` | `0.05` |

Platform-specific FFmpeg/ffprobe binaries are installed from npm with the API workspace. `FFMPEG_PATH` and `FFPROBE_PATH` optionally override them. Missing tools block the cost-approval flow before submission. Keep the existing P2 storage quota/free-space settings; original media, generated videos, keyframes, thumbnails and staging reservations share that quota. The video budget is separate from the P3 analysis budget. The environment default initializes a project's video budget; later changes to an existing project's budget are made explicitly in the UI.

### Workflow, approval and privacy

1. Save a P3 storyboard. Both protagonists need current likeness permission and at least **two reference photos each**. Review the selected scene and save its confirmation. Other scenes can remain awaiting individual review; duration, source, stale-reference or other mechanical validation errors must be corrected first.
2. Open **Storyboard → Scene clips**. For `ORIGINAL_ANIMATION`, explicitly choose the source image if the scene contains several photographs. That image becomes the start frame, with restrained movement and preservation instructions. The app does not pretend that one start image animates every photo in a montage.
3. For `NEW_CINEMATIC_SCENE`, the app prepares a clearly fictional keyframe using two approved reference photos for each person named in that scene, then animates that keyframe. One or both protagonists are supported. Separate references do not guarantee consistent likeness; compare the keyframe and clip yourself. Anonymous scenes need a supported scene setup before this character workflow can run. Titles and photo montages have no pretend generation button; those assembly steps belong to P5.
4. Click **Review generation cost**. The owner-bound quote expires after five minutes and lists the actual requested model, source, prompt, clip settings, audio, operation count, cost breakdown, remaining budget and any unknown earlier charge. Opening it makes no generation request. Confirm permission for everyone visible in the sources and approve the displayed estimate to create the job.
5. The server creates versioned private keyframe/video assets, validates the MP4 and extracts a thumbnail and three representative frames. The HTML5 player supports authenticated range requests. Compare the original or fictional keyframe with the video; read advisory visual-quality flags and accept or reject the clip. AI scores do not verify identity and no face embeddings are created.
6. **Refine this version** continues the saved Interactions conversation with a new approved cost quote and preserves the prior versions. **Regenerate** is a separate paid request with separate approval. Previous storyboard versions remain visible, but an old acceptance does not make a changed storyboard ready for P5.

Background video Interactions use stored history for operation recovery and conversational refinement; Google documents default paid-interaction retention of 55 days. Provider-side history is authenticated rather than public storage. Expired history may require a new explicitly approved generation. Originals stay local; only approved resized inputs are sent to Google. Remote file capabilities and operation IDs remain server-side, with encrypted SQLite checkpoints; frontend media links always use authenticated local endpoints. See [background execution and cancellation](https://aistudio.google.com/docs/background-execution).

### Estimates and budget safety

For Omni 1.1, the current 720p video output rate is 5,792 tokens/second at $17.50/million video-output tokens, plus input and other output consumption. Eight seconds of video output alone estimates **$0.81088**, not the entire request cost. Quotes conservatively reserve up to 131,072 input tokens at $1.50/million and 65,536 output tokens at the higher applicable output rate: **$1.343488 for the video step**, plus **$0.05 advisory review** and, for a new fictional scene, **$0.25 keyframe**. Thus initial default approval estimates are approximately **$1.393488 for Test A** and **$1.643488 for Test B**, totaling **$3.036976**. The live quote is authoritative for the configured model/settings; these are estimates, not confirmed Google charges. [Current pricing](https://aistudio.google.com/docs/pricing#gemini-omni-1.1-flash).

SQLite stores reserved and estimated spending separately from the nullable observed-charge field. Provider token usage can reconcile estimates, but it is not an invoice. Partial in-progress usage never releases the outstanding video ceiling. Missing usage and ambiguous submissions keep the conservative amount. Pricing/model/token-limit changes invalidate an unused quote, and insufficient budget blocks creation transactionally. Existing job approvals cannot reserve the same budget twice. Provider billing controls remain separate from this local estimate guard.

### Queue, interruption and cancellation

Persistent states are `PENDING`, `VALIDATING`, `GENERATING_KEYFRAME`, `GENERATING_VIDEO`, `DOWNLOADING`, `VALIDATING_OUTPUT`, `COMPLETED`, `FAILED`, `CANCEL_REQUESTED` and `CANCELLED`. Migration **4** adds the requested `video_generation_jobs`, `generated_keyframes`, `generated_video_assets`, `video_generation_attempts`, `video_quality_reviews` and `project_generation_budgets`, plus owner-bound quotes, worker leases/rate limits and private file reservations. All share the existing SQLite database; P1–P3 records and imports are preserved.

- Approval creates an application-idempotent job before the worker starts. The frontend reuses the same idempotency key if its response is lost. No provider-side idempotency guarantee is claimed.
- A paid intent is committed before every provider submission. Accepted Interactions IDs are checkpointed immediately, and unfinished work resumes status polling after restart. Completed local file checkpoints are reused rather than downloading/generating again.
- If the connection or process fails before a paid response/operation ID is checkpointed, the job becomes an **unknown submission**. No replacement billable request runs automatically. Its estimated charge remains counted; another request needs a fresh quote, explicit approval and an additional unknown-charge acknowledgement.
- Known rejected transient submissions, rate limits, status/download failures use bounded exponential backoff. Normal Google file-activation polling is separate from that retry allowance. SDK background requests have no hidden HTTP retry or client continuation loop. Polling and downloads have a bounded 24-hour local recovery window.
- **Continue saved operation** resumes known provider/local checkpoints without a new video or keyframe submission. An originally approved advisory quality step may still run. Unknown paid submissions cannot use this action.
- Cancellation stops local work and further polling and requests provider cancellation where documented. Accepted work can still finish or incur charges; cancellation does not promise a refund. Revoked consent still allows cancelling an owned provider operation. Current consent, references and sources are rechecked before further generation.
- ffprobe validates duration, exact dimensions/aspect, video/audio codecs and audio presence; FFmpeg decodes the entire output before acceptance and creates preview frames. AI visual review remains advisory. If an advisory request is unavailable or ambiguous, a validated clip can remain previewable with a manual-review warning; no false identity-verification result is manufactured.

### Controlled P4 validation — initial handoff plan

At the initial P4 handoff, the implementation had **not run either paid test**; subsequent user-approved runs are reflected by the app’s private clip history. The local `data/p4-validation-plan.json`, when prepared, records the existing storyboard's two candidate scenes without changing their review state or submitting jobs.

| Test | Planned pipeline | Initial settings | Expected paid operations | Output/identity status |
| --- | --- | --- | --- | --- |
| A | One approved original Google Photos image → Omni animation → advisory review | Omni 1.1, 8s, 720p, 16:9, native audio | 1 video + 1 review | Not run; duration/resolution and appearance unverified |
| B | Two approved references per protagonist → fictional Gemini keyframe → Omni image-to-video → advisory review | Image model 3.1 Flash Image, Omni 1.1, 8s, 720p, 16:9, native audio | 1 keyframe + 1 video + 1 review | Not run; likeness consistency unverified |

For each test, review/confirm the selected P3 scene and save that version, open its cost preview, verify settings and budget, then explicitly approve **that one job**. Review the original/keyframe beside the resulting clip, all sampled frames and the audio. Record requested/resolved model, job status, ffprobe dimensions/duration, estimated spending and your visual observations; do not call the likeness verified. Complete and review A before moving to B so an account/model restriction is discovered with the simpler workflow. If Google rejects a person or source, use the actual safe error and another consented source or revised fictional scene; the app does not bypass safeguards. P5 local assembly and P6 orchestration are now implemented and covered by synthetic tests; live clip quality and likeness still require your review.

## P3 setup and first storyboard — manual

Google Photos OAuth and Gemini use **separate credentials**. Existing P2 imports remain usable without a Gemini key.

1. Create a Gemini Developer API key in [Google AI Studio](https://aistudio.google.com/api-keys). Enable the relevant API/billing and confirm that your account can use the configured model. Put the key in **server-only** `GEMINI_API_KEY` in root `.env`; never use a `VITE_` prefix. Restart the API.
2. The default model is `gemini-3.5-flash-lite`, a stable multimodal model supporting structured output. `GEMINI_MODEL` is configurable; the server verifies model availability using the official Google GenAI SDK before sending an analysis request. Model availability is account-specific. See [model capabilities](https://aistudio.google.com/docs/models/gemini-3.5-flash-lite), [structured output](https://aistudio.google.com/docs/structured-output), [image input](https://aistudio.google.com/docs/image-understanding), and the [official JavaScript SDK](https://github.com/googleapis/js-genai).
3. Import photos through P2. In **AI Director → Overview**, choose **Analyze photos**. This explicit action sends orientation-correct, resized private JPEG copies to Gemini, with no publicly accessible photo URLs. Original files stay local. Saved descriptions and quality scores appear on the AI analysis overview; choose **View all analyzed photos** to inspect the full collection. Existing results are reused. Analysis describes visible content; no identity matching, face embeddings, or biometric database is built.
4. In **Protagonists**, give both people names, choose **at least 2 reference photos each** (up to 10), and confirm permission to use each person's likeness. Two photos per person are enough to create a storyboard; existing larger reference selections remain supported. Partial profiles can be saved, but a storyboard requires both complete profiles. A reference assignment is an explicit identity association. Use **Photo curation** to confirm additional solo/shared associations, inspect quality and duplicate candidates, pin favorites, or exclude unwanted photos. Clearing or changing associations remains your decision.
5. Open **Storyboard**, choose a duration from **120–900 seconds** (default **150**), add an optional brief, and direct the storyboard. Generation sends the confirmed reference previews and curated analysis summaries to Gemini. New cinematic scenes are explicitly **fictional / AI-created**, require your confirmation, and never claim to document an actual event.
6. Edit descriptions, camera/motion/generation prompts and scene durations. Save a new version, correct validation issues, and confirm review-required scenes. **Ready for video generation** appears only after validation. Export the authenticated JSON for P4. There is no video-generation action in P3.

A missing API key disables external AI actions while profiles, local media, and stored results stay available. The automated test suite mocks Gemini; a passing suite does not demonstrate live model access or successful analysis with your key. A real manual check is still required: analyze several known photos, verify the visible descriptions and metadata, finish both profiles, generate a storyboard, edit it, confirm fictional scenes, and export the validated version.

### Analysis reliability, privacy and spending

- Each photo is processed independently with bounded concurrency (default **2**) and configurable batches (**20**). SQLite checkpoints survive browser closure and server restarts. The worker loads only a bounded number of image previews; it never buffers the entire photo collection. Metadata is paginated, and curation retains a bounded automatic candidate pool plus explicit pins. Photo and reference grids virtualize visible rows.
- Cache identity includes the original SHA-256, model and pipeline version. Completed matching analyses are reused; new imports are analyzed incrementally. Changing the model or `ANALYSIS_PIPELINE_VERSION` intentionally makes earlier analyses stale. Starting again does not repeat matching completed work.
- A separate fenced worker lease protects P3 without interfering with P2 imports. Cancellation preserves completed analyses. Resume retains checkpoints; retry failed photos resets only failed attempts. If a process dies while Google is handling a request, that uncertain request can be submitted again on recovery; exact-once billing across a network interruption is impossible. Its previous spending reservation remains counted.
- HTTP 429, transient network failures and upstream service errors retry with exponential backoff, jitter and `Retry-After`; attempts persist. A persistent shared model cooldown stops new photo requests during rate-limit backoff, including across worker restarts. Malformed JSON is validated using strict Zod schemas and retried within a smaller bound. Invalid keys, unavailable models and exhausted spending pause the run for a configuration fix. Gemini errors use safe local messages without copying SDK request bodies or credentials into logs.
- A persistent project ledger covers **both analysis and storyboard requests**, including retries and malformed billable output. The server counts input tokens and reserves estimated input plus the maximum output before sending a generation call. Known usage (including thinking tokens) is reconciled; interrupted/unknown requests retain the full reservation. No hidden SDK retries, automatic continuation, public uploads, or paid tools are enabled.
- `GEMINI_MAX_PROJECT_SPEND_USD=10` is a local **estimated-spend** guard, not a Google billing cap. Prices default to standard Gemini 3.5 Flash-Lite rates of **$0.30/million input tokens** and **$2.50/million output tokens**, checked against [Google pricing](https://aistudio.google.com/docs/pricing#gemini-3.5-flash-lite). Update the two price variables when changing model/tier or when Google changes rates; input counting and estimates can differ from the final bill. Configure provider billing controls separately. Google's published pricing distinguishes free-tier data use from paid-tier data use; choose an account/tier suitable for private photos before starting analysis.
- Local whole-image perceptual hashes flag obvious near duplicates; they do not identify faces or guarantee semantic similarity. Duplicate candidates are retained, and pinned photos override automatic repetition avoidance. Dates/GPS/camera fields come only from existing EXIF or Google metadata and carry evidence-source labels. Missing metadata stays unknown. Google Picker original downloads can omit GPS, so location metadata may be unavailable even when the original library photo had it.
- Gemini receives a compact storyboard response schema. Nested array bounds and UUID patterns can exceed its constrained-output grammar limits and cause HTTP 400; the server retains full Zod validation after generation. Scene IDs, ordering and review state are server-owned. The app fits estimated scene timings to the requested duration and keeps all pinned photos before validating the saved draft. See [Google’s schema-complexity guidance](https://aistudio.google.com/docs/structured-output#simplifying-complex-schemas).
- Curation combines technical scores, storytelling, movement suitability, diversity, actual chronology and explicit protagonist associations. It retains solo and shared moments. Undated photos receive thematic placement. Storyboards use approximately 40–60% original animation/montage and 40–60% fictional new footage (excluding title sequences).
- All P3 endpoints inherit the existing workspace cookie, ownership checks and CSRF guard. Originals and thumbnails use authenticated local media endpoints. No Gemini key, Google token, raw upstream error, or private photo is logged. Likeness consent is required for each protagonist; ambiguous photos stay unassigned until the user associates them.

### P3 configuration

All values are documented in `.env.example`. Defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | empty | Server-only Gemini Developer API key |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Multimodal structured-output model |
| `GEMINI_TIMEOUT_MS` | `60000` | Per-request timeout |
| `GEMINI_MAX_OUTPUT_TOKENS` | `12288` | Global output ceiling; photo calls request 2,048, storyboards 12,000 |
| `GEMINI_INPUT_PRICE_PER_MILLION` | `0.30` | Estimated USD input price |
| `GEMINI_OUTPUT_PRICE_PER_MILLION` | `2.50` | Estimated USD output/thinking price |
| `GEMINI_MAX_PROJECT_SPEND_USD` | `10` | Shared project estimated-spend ceiling |
| `ANALYSIS_CONCURRENCY` | `2` | Simultaneous photo analyses |
| `ANALYSIS_BATCH_SIZE` | `20` | Bounded database work batches |
| `ANALYSIS_MAX_ATTEMPTS` | `5` | Maximum attempts for transient failures |
| `ANALYSIS_RETRY_BASE_MS` | `1000` | Initial backoff interval |
| `ANALYSIS_PIPELINE_VERSION` | `photo-v1` | Cache invalidation/version label |
| `ANALYSIS_IMAGE_MAX_DIMENSION` | `1024` | Maximum analysis preview edge in pixels |
| `ANALYSIS_NEAR_DUPLICATE_DISTANCE` | `5` | Maximum differing bits in a 64-bit whole-image hash |

### P3 migration and P4 contract

Startup applies additive SQLite migration **3**, recorded in `schema_migrations` and `PRAGMA user_version`. It adds `p3_analysis_runs`, `p3_analysis_items`, `p3_worker_lease`, `p3_rate_limits`, `p3_local_features`, `p3_photo_analysis`, `p3_protagonists`, `p3_photo_settings`, `p3_usage`, and `p3_storyboards`. Existing P2 projects, assets, source metadata, queue state, encrypted sessions and originals are preserved. Foreign keys remove dependent photo results/settings when a local asset is deleted; protagonist setup and storyboard readiness are rechecked against current ownership and references.

Storyboards are immutable **content versions** with project/version IDs, a schema version, target duration, complete scene-generation fields and validation state. Saving edits creates another version. Each scene has a unique ID, ordered sequence number, type, title, description, duration, private source IDs, confirmed protagonist IDs, visual style, camera direction, motion prompt, emotional tone, continuity notes, generation instructions, fiction label and user-review state. No public media URLs or credentials are exported. Changes to references, permissions, pins/exclusions or missing source files require revalidation; duration mismatches stay editable drafts. Exported JSON is consumed by the existing P4 Omni provider and P6 orchestration. P3 itself does not invoke video generation; the provider contract remains modular for future integrations.

P3 tests include **100, 500 and 1,000 simulated local photos**, mocked Gemini output, bounded concurrency, persisted restart/cancellation, duplicate/EXIF behavior, invalid JSON, rate limits, spending reservations, explicit reference assignments, pin/exclude behavior, duration/source validation and P2 regressions. No real photo collection or paid Gemini account is needed for these tests.

## Google Cloud setup — manual

1. Create or select a project in [Google Cloud Console](https://console.cloud.google.com/).
2. In **APIs & Services → Library**, enable **Google Photos Picker API** (`photospicker.googleapis.com`). The similarly named Google Picker API is a different API. See [Google's Photos configuration guide](https://developers.google.com/photos/overview/configure-your-app).
3. Configure **Google Auth platform → Branding** with an app name and contact email. Under **Audience**, choose **External**, keep the app in **Testing**, and add both people's Google accounts as **Test users**. See [Google's consent-screen setup](https://developers.google.com/workspace/guides/configure-oauth-consent).
4. Under **Data Access**, add only `https://www.googleapis.com/auth/photospicker.mediaitems.readonly`. The app requests this scope alone. It does not request unrestricted library/album access or an OpenID identity scope. See [Photos authorization scopes](https://developers.google.com/photos/overview/authorization).
5. Create an **OAuth client ID → Web application**. Set the authorized JavaScript origin to `http://localhost:5173` and the authorized redirect URI to exactly `http://localhost:3001/auth/google/callback`.
6. Put that client's ID and secret in root `.env`. Keep `GOOGLE_REDIRECT_URI` identical to the registered redirect URI. Restart `npm run dev` after changing environment values.

Google may show an unverified-app notice for your own testing project. Public distribution requires Google's applicable verification; this MVP is intended for private local use.

## Account authorization and first import — manual

1. In the **Your memories** card, connect Google Photos. Choose your account on Google's page and grant the requested Picker permission. Google redirects back to the dashboard.
2. Use that card's photo-selection action. Allow the new Picker tab/window, explicitly select photos in Google Photos, and press **Done**. Return to the dashboard to watch the import.
3. Repeat authorization and selection using **Their memories**, with the second person's account. The account owner must authorize their own account and choose what to share. Both slots belong to this browser's private local workspace; slot labels do not verify a person's identity.
4. Confirm that imported images appear in the gallery. Select/deselect images locally and use deletion to remove an imported local copy. Deletion does not delete the original in Google Photos.

The Picker cannot be embedded in an iframe. Closing its tab does not mean selection succeeded; the server waits for `mediaItemsSet`, honors Google's polling interval/timeout, then retrieves all result pages. Cancel in the dashboard to abandon an import session. The import runs on the server even if you close the dashboard. Remote cleanup is attempted when an import succeeds, expires, or is explicitly cancelled. A job with failed items keeps its Picker session while access remains valid so you can retry. If permissions were revoked and cleanup cannot be authorized, the app explains that the remote session will expire and lets you reconnect. See [session lifecycle](https://developers.google.com/photos/picker/guides/sessions) and [media listing](https://developers.google.com/photos/picker/reference/rest/v1/mediaItems/list).

## Large imports and actual Google limits

There is no application-level photo-count limit per project or per selection. You can add repeated Picker selections to the same project; the configured storage quota and available disk space are the local constraints.

Google currently limits a **single Picker session to 2,000 selected items**. Omitting `pickingConfig.maxItemCount` uses Google's default maximum; requesting more than 2,000 does not increase it. The app leaves that setting to Google. See [PickingConfig](https://developers.google.com/photos/picker/reference/rest/v1/sessions#PickingConfig).

The app follows every `nextPageToken`, including empty intermediate pages. Google allows at most **100 items per `mediaItems.list` page**; its default is 50. The importer uses pages of 100 and checkpoints each page. See [mediaItems.list](https://developers.google.com/photos/picker/reference/rest/v1/mediaItems/list).

Google documents Picker quotas of **100,000 API requests per minute per Cloud project** and **1,000,000 media-byte requests per minute per Cloud project**. Actual project quotas can be checked in Cloud Console; quota or service errors can still occur. These are Picker quotas, separate from the Library API's daily quotas. See [API limits and quotas](https://developers.google.com/photos/overview/api-limits-quotas).

## Queue, checkpoints, and recovery

- SQLite stores each job, pagination checkpoint, and item state. The default worker concurrency is **4 simultaneous downloads** across the queue. Workers claim items transactionally and use a coordinator lease to prevent two processes from importing the same queued item at once.
- Selected images begin downloading while further listing pages are checkpointed. Items with the earliest URL expiry are prioritized. The server streams bytes into private temporary files, calculates SHA-256 while streaming, validates the image type and byte limits, then commits the asset and item checkpoint.
- Completed checkpoints are not downloaded again after a restart. A completed file whose database commit was interrupted is recovered from its checkpoint when possible. A partially downloaded file may need to be downloaded again; a process crash cannot guarantee an uninterrupted network transfer.
- Transient network errors, HTTP 429, and upstream 5xx responses are retried automatically with exponential backoff and jitter. `Retry-After` is respected. Attempts and the next eligible retry time survive a restart. Exhausted failures remain visible and can be retried explicitly.
- Progress shows total discovered items, completed imports, failed items, skipped items, active downloads, and remaining items. The total can grow while pagination is still running. Unsupported formats and duplicate content have clear skip reasons.
- SHA-256 identifies identical image bytes within a project, including photos with different Google IDs. The first stored image and the metadata Google returned for it are preserved; additional source metadata is retained as provenance rather than replacing the first import's metadata. Google's documented `=d` download retains Exif except location metadata, so this app cannot promise GPS metadata that Google does not return. Re-selecting an already imported Google media item can be skipped before another download.
- Cancellation stops active streams and pending work, preserves completed photos, and attempts remote Picker cleanup. To import outstanding photos after explicit cancellation, start a fresh Picker selection. Normal server shutdown preserves job checkpoints and resumes eligible work on the next start.

### When an import cannot resume automatically

Google's media `baseUrl` values normally remain usable for **60 minutes**, and access may end earlier if permission is revoked. The import treats them as temporary credentials, encrypts queued copies, and never uses them as durable gallery links. A session's returned `expireTime` is authoritative; the app does not assume every session lasts one hour. See [media retrieval](https://developers.google.com/photos/picker/guides/media-items) and [session fields](https://developers.google.com/photos/picker/reference/rest/v1/sessions).

If a queued URL expires but the Picker session is still accessible, the importer lists that session again to obtain fresh URLs for outstanding media. If Google has expired or deleted the session, the job keeps all completed photos and asks you to **choose the outstanding photos again in a new Picker session**. Already imported Google IDs and content hashes prevent duplicate local copies. The app cannot reconstruct unrestricted library access or renew an expired selection silently.

If an access token expires, the server first tries its refresh token. If Google requires consent again, the job pauses with a reconnect message. Reconnect the **same Google account** in the affected contributor slot, then resume while the Picker session is still valid. If that session has expired too, renewed authorization alone is insufficient: you must also select the remaining photos again. Slot names are local labels; the Picker-only scope does not verify a person's identity.

A storage-quota or disk-space failure pauses the job before further downloads. Free space or increase the local quota, then resume if Google access is still valid; otherwise renew the selection. Picker media items do not provide an exact total byte size, so preflight checks reserve disk space conservatively and byte accounting is enforced again during streaming.

## Storage and privacy

- Local images live under `data/imports/{projectId}/` by default. SQLite stores projects, assets, original source metadata, import checkpoints, and future analysis records. Existing P2 metadata is migrated when its project is first opened. Generated filenames never depend on a remote filename.
- JPEG, PNG, WebP, and GIF images are supported. Videos, HEIC, and other unsupported items are skipped. The per-image byte limit is configurable; it is a download-safety limit, not a photo-count limit. The previous fixed 500 MiB per-import limit has been removed.
- Storage quota and minimum free disk reserve are configurable. Preflight checks run before work starts, and the importer checks limits as it streams. Quota accounting includes active reservations so concurrent workers cannot each assume the same free space.
- Media is fetched server-side with a bearer token and the documented `baseUrl=d` image download parameter. Authenticated local API URLs serve the gallery. Photos are never exposed as a public static directory, and the API has no arbitrary-URL download endpoint.
- OAuth codes, tokens, client secrets, URLs, and personal photos are not written to application logs. OAuth tokens remain in encrypted server sessions under `data/.sessions`. Queued temporary URLs and session identifiers are encrypted in SQLite using a key derived from `SESSION_SECRET`. Keep that secret stable across restarts.
- Browser cookies hold signed opaque identifiers, use `httpOnly` and `SameSite=Lax`, and use the secure flag with production HTTPS. Development HTTP uses a non-secure cookie on loopback. Workspace ownership is checked for every protected API operation; mutations require a CSRF token.
- Keep the browser cookie to retain workspace access after restarting. Clearing cookies or deleting session files can orphan local projects; changing `SESSION_SECRET` invalidates sessions and encrypted queue references. The SQLite file and imported media are ordinary private local files, so the OS account and disk encryption protect their contents. All local data is gitignored.

This is a local-use authentication model, not a production multiuser login system. Keep both servers bound to loopback. Do not expose the app publicly without a separate authentication, deployment, storage, and operational design.

## Future media analysis

P2 defines media-analysis input/result interfaces and database structures for sharpness, composition, visual diversity, and storytelling scores, plus analysis status, model/version, and provenance. These structures let a future worker score large collections automatically instead of requiring manual review of every photo. P2 does **not** call Gemini, upload media for analysis, calculate AI scores, or generate a movie.

## Environment

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google Web application OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Server-only OAuth client secret |
| `GOOGLE_REDIRECT_URI` | Exact registered callback; default `http://localhost:3001/auth/google/callback` |
| `GOOGLE_PHOTOS_SCOPE` | Picker read scope shown above; broader scopes are not used |
| `WEB_ORIGIN` | Allowed frontend origin; default `http://localhost:5173` |
| `API_PORT` | Local API port; default `3001` |
| `SESSION_SECRET` | Random secret of at least 32 characters for signed cookies and session encryption |
| `MEDIA_STORAGE_PATH` | Local image storage root; default `./data/imports`, resolved from the repository root |
| `DATABASE_PATH` | SQLite database path; default `./data/studio.sqlite` |
| `IMPORT_CONCURRENCY` | Simultaneous downloads across the worker queue; default `4` |
| `IMPORT_BATCH_SIZE` | Items checkpointed/claimed in a processing batch; default `100` (Google list pages are independently capped at 100) |
| `IMPORT_MAX_ATTEMPTS` | Maximum automatic attempts per item before manual retry; default `5` |
| `IMPORT_RETRY_BASE_MS` | Base exponential retry delay in milliseconds; default `1000`; Google `Retry-After` takes precedence when longer |
| `STORAGE_QUOTA_BYTES` | Local imported-media quota in bytes; default `21474836480` (20 GiB) |
| `MIN_FREE_DISK_BYTES` | Free disk reserve retained during imports; default `134217728` (128 MiB) |
| `MAX_IMAGE_BYTES` | Per-image safety limit in bytes; default `104857600` (100 MiB) |

## Checks and structure

```sh
npm test
npm run typecheck
npm run build
```

`npm run test:watch` starts Vitest in watch mode. After building, `npm run start -w @memories/api` starts the compiled API. The web build is in `apps/web/dist`.

```text
apps/web          React 18, TypeScript, Vite, Tailwind, shadcn/ui components
apps/api          Express, OAuth, Picker, SQLite queue, private imports/API
packages/shared   Shared TypeScript contracts and Zod schemas
data/imports      Private local media, organized by project (gitignored)
data              SQLite database, encrypted sessions, temporary state (gitignored)
```

Automated tests include imports of 100, 500, and 1,000 simulated photos, with mocked Google responses and temporary private SQLite/media storage. They also cover concurrency, pagination, retries, duplicate detection, cancellation, and checkpoint recovery. They verify local behavior without granting access to a real Google account. A passing test/build does not prove that a Google Cloud project, consent screen, account permission, or live Picker session works. Complete the manual authorization/import steps above to verify the live integration with your accounts.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Google setup is unavailable | Fill both client credentials in `.env` and restart the API. |
| `redirect_uri_mismatch` | Register the exact callback URL, including protocol, hostname, port, and path. |
| Google denies access | Add the account as a test user and grant the Picker scope. Workspace administrators may restrict authorization. |
| Reconnection is requested | A refresh token may have expired or been revoked. Reauthorize that slot; test-mode Google projects can require periodic reauthorization. |
| Picker does not open | Allow popups for `localhost:5173`, then retry from the dashboard. |
| Empty selection, cancellation, or expiration | Start a new session and finish the selection with **Done** before its deadline. |
| Unsupported item or file too large | Choose a supported image within the configured byte limit. |
| Storage quota or low disk space | Free disk space or adjust the quota/reserve settings, then resume while the Picker session is still live. |
| Import cannot resume | Follow the job message: reconnect the same account if authorization expired, and start a new Picker selection if the selection itself expired. Completed local photos are retained. |
| Google rate limit or service error | The queue retries transient failures with backoff. Failed items remain retryable while the Picker session is valid; successful imports and cancellations trigger cleanup. |

## Diagnosing a Google Photos connection

The authorization URL requests exactly `https://www.googleapis.com/auth/photospicker.mediaitems.readonly`, with PKCE, a single-use browser-bound state, offline access, and an explicit consent/account chooser. Configuring a scope in Google Cloud does not retroactively add it to an already stored token. A contributor is shown as connected only when the stored authorization includes the required Picker grant; missing or invalid grants require **Reconnect Google Photos**. Reconnect replaces that contributor's credentials after a successful callback and preserves the other contributor and the local project.

Use **Check connection** on the affected contributor card to refresh that account's token with the configured client ID/secret and inspect Google's actual token audience and granted scopes. The result reports a client fingerprint, project-number hint, and whether the required grant was verified; it never returns tokens, secrets, or the Google account identifier. A successful check validates the OAuth pair and grant, but does not itself establish that the Picker API is enabled. **Choose photos** must still successfully create a real Picker session. Use **Reconnect Google Photos** when the card reports missing/stale permission.

The corresponding authenticated endpoints are `GET /api/connections/{person1|person2}/diagnostics` and `POST /api/connections/{person1|person2}/verify`. Verification requires the normal CSRF header. Diagnostics are private to the browser workspace and record errors separately for each contributor. The client project-number field is a hint to compare with Cloud Console, not a substitute for checking the actual API consumer project reported by Google.

The server distinguishes the failing operation (`oauth.token`, `oauth.tokenInfo`, `picker.sessions.create`, `picker.sessions.get`, `picker.sessions.delete`, `picker.mediaItems.list`, or `media.download`). Safe diagnostics include HTTP status, Google's error code/status, a sanitized message, and allowlisted `google.rpc.ErrorInfo` fields such as reason, service, and consumer project number. Access tokens, refresh tokens, client secrets, authorization codes, media URLs, email addresses, and raw upstream response bodies must never be copied into logs or shared in a bug report.

| Evidence | Action |
| --- | --- |
| `ACCESS_TOKEN_SCOPE_INSUFFICIENT` / missing Picker grant | Reconnect the affected contributor and approve the Picker permission. The API does not assume enabling the API repairs an old token. |
| HTTP 401 / expired access token | The server refreshes once. If refresh fails or Google rejects the refreshed token, reconnect the same account. |
| `SERVICE_DISABLED` / explicit API-disabled reason | Check the **consumer project in the diagnostic**. Enable Photos Picker API in that exact project, rather than assuming the currently open Cloud Console project is the one serving the client. |
| Token audience does not match `GOOGLE_CLIENT_ID` | Use the intended Web application OAuth client and reconnect. An old token from another client must not be reused. |
| `invalid_client` / `unauthorized_client` | Check the client ID/secret pair and registered callback. A client secret cannot be assigned to a project by inspecting its text. |
| OAuth testing access is blocked | In the intended Cloud project, open **Google Auth Platform → Audience → Test users** and add the authorizing Google account. A user declining consent can also produce `access_denied`; that error alone does not prove a testing configuration problem. See [Google's audience configuration](https://support.google.com/cloud/answer/15549945) and [access-denied causes](https://support.google.com/accounts/answer/16668185). |
| Explicit account/session ownership mismatch | Reconnect the account that owns the Picker session in the affected contributor slot. Tokens and sessions are never borrowed from the other slot. |
| Expired/deleted Picker session | Keep completed local photos and create a new selection for outstanding photos. Authorization alone cannot restore an expired selection. |
| An otherwise unclassified HTTP 403 | Use the actual Google reason/message. HTTP 403 by itself is not evidence that the API is disabled. |

To verify Cloud configuration, compare the configured client with **Google Auth Platform → Clients** in the project where Photos Picker API is enabled. Compare any reported consumer project number with **Project settings → Project number**. A successful OAuth token exchange verifies the supplied client ID/secret pair; a matching token audience verifies the token's client. Neither check alone proves that an unrelated Cloud Console project has the API enabled. Live end-to-end verification requires a successful `POST https://photospicker.googleapis.com/v1/sessions` with the user's authorized account. See [Google's Web server OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Photos configuration](https://developers.google.com/photos/overview/configure-your-app), and [Picker session creation](https://developers.google.com/photos/picker/reference/rest/v1/sessions/create).

The Picker-only permission does not guarantee an identity/email claim. When Google supplies a stable account identifier in token introspection, the server can compare it with the previously bound account; otherwise it reports identity as unverified and still keeps each contributor's credentials isolated. Existing Picker jobs are bound to the authorizing account when Google supplies an identifier. If a connection changes and ownership of an old selection cannot be verified, the app requests a new selection rather than silently using the replacement account. Do not infer a verified person's identity from a local slot label.
