
// NOVA MOTION 4.0 FUNCTIONS

let novaMotionMode = "text";
let novaMotionPlan = null;
let novaMotionJob = null;
let novaMotionPendingJobId = null;
let novaMotionImageFile = null;

// Stage 3.4C: project-aware selection. Both null means standalone.
// The project workspace UI (Stage 3.4D) sets these.
let novaSelectedProjectId = null;
let novaSelectedCharacterId = null;

function openMotionStudio() {
  document.getElementById("motionStudio").style.display = "block";
  document.body.style.overflow = "hidden";
  document.getElementById("sidebar").classList.remove("open");
  novaRenderJobs();
  novaRenderProductionIdentity();
  novaRefreshCapacity();
}

function closeMotionStudio() {
  document.getElementById("motionStudio").style.display = "none";
  document.body.style.overflow = "";
}

function setMotionMode(mode) {
  novaMotionMode = mode;

  document.getElementById("textMode").classList.toggle("active", mode === "text");
  document.getElementById("imageMode").classList.toggle("active", mode === "image");

  document.getElementById("motionUploadArea").style.display =
    mode === "image" ? "block" : "none";
}


// ==========================================
// NOVA INTELLIGENCE 2.0 — PROMPT BRAIN
// Browser-based cinematic scene planner
// ==========================================

function novaExtractSubject(prompt) {
  const clean = prompt.replace(/\s+/g, " ").trim();

  const match = clean.match(
    /^(?:a|an|the)\s+(.+?)(?=\s+(?:emerges?|appears?|rises?|awakens?|comes|steps|flies|spreads?|moves?|walks?|runs?|attacks?|reveals?|opens?|transforms?)\b|[,.;!?]|$)/i
  );

  return match ? match[1].trim() : "Main subject";
}

function novaDetectActions(prompt) {
  const p = prompt.toLowerCase();

  const patterns = [
    {
      name: "Emergence",
      words: ["emerges", "emerge", "appears", "rises", "awakens", "comes out", "steps out"]
    },
    {
      name: "Flight",
      words: ["flies", "flying", "takes flight", "soars", "wings", "airborne"]
    },
    {
      name: "Movement",
      words: ["runs", "running", "walks", "walking", "moves", "approaches", "chases"]
    },
    {
      name: "Combat",
      words: ["fights", "attacks", "strikes", "battles", "explodes", "destroys", "clashes"]
    },
    {
      name: "Transformation",
      words: ["transforms", "transformation", "changes into", "turns into", "morphs"]
    },
    {
      name: "Reveal",
      words: [
        "reveals",
        "revealing",
        "glowing eyes",
        "golden eyes",
        "opens its eyes",
        "unveils"
      ]
    },
    {
      name: "Emotion",
      words: ["cries", "smiles", "laughs", "screams", "looks at", "embraces"]
    }
  ];

  return patterns
    .filter(group =>
      group.words.some(word => p.includes(word))
    )
    .map(group => group.name);
}

function novaChooseBeats(prompt, count) {
  const p = prompt.toLowerCase();
  const actions = novaDetectActions(prompt);

  const beats = [];

  if (
    p.includes("dragon") ||
    p.includes("monster") ||
    p.includes("creature") ||
    p.includes("giant")
  ) {
    beats.push({
      title: "The World and the Threat",
      direction: "Establish the environment, scale and atmosphere. Introduce the subject as a powerful presence.",
      camera: "Wide cinematic establishing shot",
      motion: "Atmospheric movement with a gradual visual reveal"
    });
  } else {
    beats.push({
      title: "Establishing Shot",
      direction: "Introduce the environment, main subject and visual atmosphere.",
      camera: "Wide cinematic establishing shot",
      motion: "Slow controlled movement"
    });
  }

  if (actions.includes("Emergence")) {
    beats.push({
      title: "The Emergence",
      direction: "Show the subject emerging into view. Make the movement physically convincing and visually dramatic.",
      camera: "Slow cinematic push-in",
      motion: "Subject advances into the frame"
    });
  } else if (actions.includes("Flight")) {
    beats.push({
      title: "The Ascent",
      direction: "Show the subject taking flight, with convincing movement and a clear sense of scale.",
      camera: "Dynamic tracking shot",
      motion: "Subject moves through the environment"
    });
  } else if (actions.includes("Combat")) {
    beats.push({
      title: "The Conflict",
      direction: "Develop the main confrontation with readable movement and strong visual impact.",
      camera: "Dynamic tracking shot",
      motion: "Controlled action and reaction"
    });
  } else if (actions.includes("Transformation")) {
    beats.push({
      title: "The Transformation",
      direction: "Show the subject changing form while preserving recognisable features and visual continuity.",
      camera: "Gradual cinematic push-in",
      motion: "Progressive transformation"
    });
  } else if (actions.includes("Movement")) {
    beats.push({
      title: "The Movement",
      direction: "Show the subject moving through the environment with clear direction and purpose.",
      camera: "Smooth tracking shot",
      motion: "Continuous subject movement"
    });
  } else {
    beats.push({
      title: "The Main Action",
      direction: "Develop the central action described in the user's prompt.",
      camera: "Medium cinematic shot",
      motion: "Natural, controlled subject movement"
    });
  }

  if (actions.includes("Reveal")) {
    beats.push({
      title: "The Visual Reveal",
      direction: "Bring attention to the important visual detail and make the reveal unmistakable.",
      camera: "Close-up push-in",
      motion: "Controlled reveal with a brief visual hold"
    });
  }

  beats.push({
    title: "The Cinematic Payoff",
    direction: "Deliver the strongest visual moment from the prompt and finish with a memorable composition.",
    camera: "Hero shot",
    motion: "Powerful final movement followed by a brief hold"
  });

  // When only two scenes fit, the slice below would discard the reveal
  // beat. Fold it into the second beat instead, so the reveal survives.
  if (count === 2 && actions.includes("Reveal")) {
    const revealIndex = beats.findIndex(
      beat => beat.title === "The Visual Reveal"
    );
    if (revealIndex > 1) {
      beats[1].title += " and the Reveal";
      beats[1].direction +=
        " End the scene with the visual reveal: bring attention to the important visual detail and make the reveal unmistakable.";
      beats[1].motion += ", then a controlled reveal with a brief visual hold";
      beats.splice(revealIndex, 1);
    }
  }

  while (beats.length < count) {
    beats.splice(beats.length - 1, 0, {
      title: "Action Development",
      direction: "Continue the main action while preserving the subject's appearance, environment and spatial continuity.",
      camera: "Cinematic tracking shot",
      motion: "Progressive movement"
    });
  }

  return beats.slice(0, count);
}

function novaDistributeTime(total, count) {
  const base = Math.floor(total / count);
  const remainder = total % count;

  return Array.from(
    { length: count },
    (_, index) => base + (index < remainder ? 1 : 0)
  );
}

function novaEscape(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function buildMotionPlan() {
  const prompt = document
    .getElementById("motionPrompt")
    .value.trim();

  const character = document
    .getElementById("motionCharacter")
    .value.trim();

  // Phase 3: only the proven LTX preset is offered (1024x576, 16:9).
  // The aspect-ratio selector was removed from the page (Rev 2 §5.1 Q3).
  const ratio = "16:9";
  const duration = Number(document.getElementById("motionDuration").value);
  const style = document.getElementById("motionStyle").value;
  const camera = document.getElementById("motionCamera").value;

  const image = document.getElementById("motionImage").files[0];

  const output = document.getElementById("motionOutput");
  const empty = document.getElementById("motionEmpty");

  if (!prompt) {
    alert("Please describe the video you want to create.");
    return;
  }

  if (prompt.length > 2000) {
    alert("Please shorten your video description to 2,000 characters.");
    return;
  }

  if (
    novaMotionMode === "image" &&
    !image
  ) {
    alert("Please upload a reference image.");
    return;
  }

  const sceneCount = Math.min(
    6,
    Math.max(1, Math.ceil(duration / 5))
  );

  const subject = novaExtractSubject(prompt);
  const actions = novaDetectActions(prompt);

  const beats = novaChooseBeats(prompt, sceneCount);
  const timings = novaDistributeTime(duration, sceneCount);

  // Stage 3.4E: when a project + character are selected, the
  // saved continuity strengthens each scene prompt. The user's
  // original prompt text is never modified.
  let continuityLine = "";
  if (novaSelectedProjectId && novaSelectedCharacterId) {
    const built = novaBuildContinuityContext(
      novaSelectedProjectId,
      novaSelectedCharacterId
    );
    if (built && built.context) {
      continuityLine = novaContinuitySceneLine(built.context);
    }
  }

  // Stage 3.5A: the plan cast is the project's characters,
  // in order. A single-character cast keeps the 3.4E line
  // (byte-identical, A12); a multi-character cast gets one
  // identity line per character, built inside the scene loop
  // with the correct scene number (Correction 1). The style
  // block carries the plan's styleBasis as a separate line.
  // The legacy "Visual style: <motionStyle>" line is
  // untouched (locked tests pin it); full dropdown
  // replacement is deferred.
  // Final correction: the block runs whenever a project is
  // selected — cast validation depends on the CAST itself,
  // never on the selected-character gate (A7, Section 3.3:
  // "a plan never builds with an unvalidated cast"). The
  // identity lines come from the cast, not the selection,
  // so a plan with no selected character still validates
  // its cast and still carries its identity lines; a
  // foreign selected character is ignored for identity
  // purposes and never enters the cast (validation would
  // refuse it if the project's list named it). The deleted
  // selected character stays a NARROW exception — only its
  // own id is dropped from the cast before validation
  // (Correction 2); every other cast member is validated
  // normally, so a plan never builds with an unvalidated
  // cast.
  let planCast = [];
  let planCastContexts = [];
  let planStyleBasis = null;
  let styleBlock = "";
  const selectedCharacterForPlan = novaSelectedCharacterId
    ? novaGetCharacter(novaSelectedCharacterId)
    : null;
  if (novaSelectedProjectId) {
    const selectedProject = novaGetProject(novaSelectedProjectId);
    if (selectedProject) {
      let cast = Array.isArray(selectedProject.characterIds)
        ? selectedProject.characterIds.slice()
        : [];
      // Narrow deleted-selected exception (Correction 2):
      // drop exactly the deleted selected character's id.
      // The exception is selected-only — any other ghost or
      // foreign id still refuses the build.
      if (novaSelectedCharacterId && !selectedCharacterForPlan) {
        cast = cast.filter((id) => id !== novaSelectedCharacterId);
      }
      const castError = novaValidateCast(selectedProject, cast);
      if (castError) {
        alert(castError);
        return;
      }
      planCast = cast;
      const castCharacters = cast
        .map((id) => novaGetCharacter(id))
        .filter(Boolean);
      if (cast.length === 1) {
        // Single character: the 3.4E line, byte-identical.
        const castLines = novaBuildCastLines(
          selectedProject,
          castCharacters,
          null
        );
        if (castLines.error) {
          alert(castLines.error);
          return;
        }
        continuityLine = castLines.lines[0] || "";
      } else if (cast.length > 1) {
        // Multi-character: contexts are built once here;
        // the per-scene lines (with the correct scene
        // number) are built inside the scene loop.
        const built = novaBuildCastContexts(
          selectedProject,
          castCharacters
        );
        if (built.error) {
          alert(built.error);
          return;
        }
        planCastContexts = built.contexts;
        continuityLine = "";
      }
      planStyleBasis = novaGetProjectVisualStyle(selectedProject);
      styleBlock =
        "Visual style: " +
        novaVisualStyleFragment(
          planStyleBasis.preset,
          planStyleBasis.customDirection
        );
    }
  }

  let elapsed = 0;

  const scenes = beats.map((beat, index) => {
    const start = elapsed;
    const end = elapsed + timings[index];

    elapsed = end;

    const scenePrompt = [
      "Create a cinematic video scene.",
      "Original concept: " + prompt,
      "Scene direction: " + beat.direction,
      "Visual style: " + style,
      "Camera direction: " + beat.camera,
      "Preferred camera movement: " + camera,
      "Subject movement: " + beat.motion,
      "Character continuity: " + (
        character ||
        "Maintain the same subject identity and appearance throughout the sequence."
      ),
      ...(continuityLine ? [continuityLine] : []),
      ...(planCastContexts.length > 1
        ? novaCastIdentityLines(planCastContexts, index + 1)
        : []),
      ...(styleBlock ? [styleBlock] : []),
      "Environment and visual continuity must remain consistent with previous scenes.",
      "Aspect ratio: " + ratio
    ].join(" ");

    return {
      title: beat.title,
      start,
      end,
      duration: timings[index],
      direction: beat.direction,
      camera: beat.camera,
      motion: beat.motion,
      prompt: scenePrompt
    };
  });


// Save the accepted production plan for the generation engine.
const imageInput = document.getElementById("motionImage");

novaMotionImageFile =
  imageInput && imageInput.files.length
    ? imageInput.files[0]
    : null;

novaMotionPlan = {
  scenes: scenes,
  prompt: prompt,
  character: character,
  mode: novaMotionMode,
  ratio: ratio,
  duration: duration,
  style: style,
  camera: camera,
  projectId: novaSelectedProjectId || null,
  cast: planCast,
  styleBasis: planStyleBasis,
  version: 1,
  // Stage 3.5B: continuity decisions + the revalidation
  // watermark (Section 16.2). A fresh plan starts with no
  // decisions; the watermark is set below to the current
  // versions (a fresh plan owes no revalidation).
  continuityDecisions: [],
  decisionsCheckedAt: null,
  image: novaMotionImageFile
    ? {
        name: novaMotionImageFile.name,
        type: novaMotionImageFile.type,
        size: novaMotionImageFile.size
      }
    : null
};

  // Stage 3.5B: stable scene IDs (Section 11) + the state
  // chain (Section 14). New scenes get ids at creation;
  // the watermark is set to the current versions (a fresh
  // plan owes no revalidation); the chain is built once
  // and the scene prompts are rebuilt through the shared
  // builder (which includes the state line) so the plan's
  // prompts and the snapshot agree. A chain error blocks
  // the build and clears the plan (defensive only — a
  // fresh plan declares no changes, so its chain cannot
  // be invalid; the cast was already validated above).
  if (novaMotionPlan.projectId) {
    const planProject = novaGetProject(novaMotionPlan.projectId);
    if (planProject) {
      const assigned = novaAssignSceneIds(novaMotionPlan);
      if (assigned.notices.length) {
        alert(assigned.notices.join("\n"));
      }
      novaMotionPlan.decisionsCheckedAt = {
        planVersion: novaMotionPlan.version,
        canonVersion: novaGetProjectCanonVersion(planProject)
      };
      const planChain = novaBuildProductionState(planProject, novaMotionPlan);
      if (planChain.error) {
        alert(planChain.error);
        novaMotionPlan = null;
        return;
      }
      const rebuiltPlan = novaRebuildPlanPrompts(novaMotionPlan, planChain);
      if (rebuiltPlan.error) {
        alert(rebuiltPlan.error);
        novaMotionPlan = null;
        return;
      }
    }
  }

const generateButton = document.getElementById("motionGenerateButton");

if (generateButton) {
  generateButton.disabled = false;
}

  const sceneHTML = scenes.map((scene, index) => `
    <div class="motion-scene">
      <h3>SCENE ${index + 1}: ${novaEscape(scene.title)}</h3>
      <p><strong>Timeline:</strong> ${scene.start}s – ${scene.end}s</p>
      <p><strong>Duration:</strong> ${scene.duration} seconds</p>
      <p><strong>Visual direction:</strong> ${novaEscape(scene.direction)}</p>
      <p><strong>Camera:</strong> ${novaEscape(scene.camera)}</p>
      <p><strong>Subject movement:</strong> ${novaEscape(scene.motion)}</p>
      <p><strong>Generation prompt:</strong></p>
      <p>${novaEscape(scene.prompt)}</p>
    </div>
  `).join("");

  const actionText = actions.length
    ? actions.join(", ")
    : "General subject action";

  output.innerHTML = `
    <h3>NOVA INTELLIGENCE PRODUCTION BRIEF</h3>

    <p><strong>Detected subject:</strong> ${novaEscape(subject)}</p>
    <p><strong>Detected actions:</strong> ${novaEscape(actionText)}</p>
    <p><strong>Generation mode:</strong> ${novaMotionMode === "text" ? "Text to Video" : "Image to Video"}</p>
    <p><strong>Visual style:</strong> ${novaEscape(style)}</p>
    <p><strong>Preferred camera:</strong> ${novaEscape(camera)}</p>
    <p><strong>Aspect ratio:</strong> ${novaEscape(ratio)}</p>
    <p><strong>Total duration:</strong> ${duration} seconds</p>
    <p><strong>Number of scenes:</strong> ${scenes.length}</p>
    <p><strong>Character identity:</strong> ${novaEscape(character || "Continuity instructions enabled")}</p>

    <h3 class="motion-breakdown-heading">CINEMATIC SCENE BREAKDOWN</h3>
    ${sceneHTML}

    <div class="motion-scene">
      <strong>GLOBAL CONTINUITY RULES</strong>
      <p>Maintain consistent subject identity, anatomy, colours, proportions, environment and lighting across all scenes.</p>
      <p>Preserve the intended action and spatial relationships. Avoid unexplained changes in character appearance or location.</p>
      <p>Final timeline: ${elapsed} seconds.</p>
    </div>

    <p class="motion-note">
      NOVA Prompt Brain 2.0 · Rule-based cinematic planning.
      AI model interpretation and actual video rendering are not yet connected.
    </p>
  `;

  empty.style.display = "none";
  output.style.display = "block";

  // Stage 3.4E: refresh the identity review so continuity
  // warnings reflect the final prompt text.
  novaRenderProductionIdentity();

  // Stage 3.5A: render the per-scene presence + override
  // controls for the new plan.
  novaRenderSceneContinuityControls();

  // Stage 3.5B: render the per-scene state controls for
  // the new plan.
  novaRenderSceneStateControls();
}



/* =========================================
   NOVA MOTION PRODUCTION ENGINE
   Stage 3 — Integration Foundation
========================================= */

function updateMotionStatus(message, state = "idle") {
  const status = document.getElementById("motionStatus");
  const preview = document.getElementById("motionPreview");

  if (status) {
    status.textContent = message;
    status.dataset.state = state;
  }

  if (preview && state !== "completed") {
    preview.textContent = message;
  }
}

async function generateMotionVideo() {
  if (!novaMotionPlan || !novaMotionPlan.scenes.length) {
    updateMotionStatus(
      "Build a cinematic scene plan before generating.",
      "failed"
    );
    return;
  }

  // Phase 3 §19.2: before a first generation, the user sees the
  // licence's use restrictions in full and acknowledges them. The
  // acknowledgement is stored in this browser only; later
  // generations proceed without showing it again.
  if (!novaLicenceNoticeAcknowledged()) {
    novaShowLicenceNotice();
    return;
  }

  const button = document.getElementById("motionGenerateButton");

  if (button) {
    button.disabled = true;
    button.textContent = "Creating job...";
  }

  let job = null;

  try {
    // Reuse an existing pending job after an uncertain request.
    if (novaMotionPendingJobId) {
      job = novaGetJob(novaMotionPendingJobId);
    }

    // Otherwise create a fresh job and persist its token first.
    // Stage 3.4C: a selected project + character takes the
    // project-aware path; otherwise the standalone path is used.
    if (!job) {
      const selection = novaGetProjectSelection();

      // Stage 3.5B: pre-creation continuity check
      // (trigger 3, Section 16.2). When the revalidation
      // removed decisions, the user confirms before the
      // job is created.
      if (selection) {
        // A deleted project is creation's error to report
        // ("The selected project does not exist.") — the
        // pre-check runs only when the project exists.
        const preCheckProject = novaGetProject(selection.projectId);
        if (preCheckProject) {
        // A plan that never went through the planner may
        // lack scene ids and continuity fields (a legacy
        // plan, or a plan built programmatically). Assign
        // them now — the Section 11 first-open — so the
        // pre-check can key warnings and decisions.
        novaAssignSceneIds(novaMotionPlan);
        novaEnsurePlanContinuityFields(
          novaMotionPlan,
          preCheckProject
        );
        const preCheck = novaPreCreateContinuityCheck(
          preCheckProject,
          novaMotionPlan
        );
        if (preCheck.error) {
          throw new Error(preCheck.error);
        }
        if (preCheck.removed > 0 && !novaMotionCreationConfirmed) {
          novaShowCreationConfirm(preCheck.message);
          if (button) {
            button.disabled = false;
            button.textContent = "Generate Video →";
          }
          return;
        }
        }
      }

      job = selection
        ? await novaCreateProjectJob(
            novaMotionPlan,
            selection.projectId,
            selection.characterId
          )
        : await novaCreateJob(novaMotionPlan);
    }

    if (
      !job.accessToken ||
      !job.productionPlan
    ) {
      throw new Error(
        "The saved job is missing its access credentials or production plan."
      );
    }

    // Stage 3.5B: the one-shot confirmation is spent,
    // and the review refreshes so the post-revalidation
    // decisions + warnings show.
    novaMotionCreationConfirmed = false;
    novaRenderProductionIdentity();

  } catch (error) {
    // Stage 3.5B: a failed creation spends no confirmation.
    novaMotionCreationConfirmed = false;
    updateMotionStatus(
      error.message || "Could not create the production job.",
      "failed"
    );

    if (button) {
      button.disabled = false;
      button.textContent = "Retry Generation →";
    }

    return;
  }

  updateMotionStatus(
    "Job " + job.id + " created. Checking provider availability...",
    "queued"
  );

  if (button) {
    button.textContent = "Submitting...";
  }

  let httpStatus = 0;

  try {
    // Phase 3 (Rev 2 §5.1): reference images are rejected — the
    // generation request carries no image. The image-upload control
    // is hidden from the page and no image is read here, so a job
    // can never be refused server-side for carrying one.
    //
    // Phase 3 retarget (Rev 2 §4.1, 25 Nov 2026): the frontend now
    // posts to POST /api/generate with the Phase 3 contract
    // (mode "plan", proven LTX preset). /api/motion-generate is
    // retired server-side. The mapped scene prompts are sent
    // verbatim — never silently truncated. Each scene prompt embeds
    // the user's description plus direction/continuity text, so a
    // scene prompt can exceed the server's 2,000-character cap even
    // when the description itself is within it; such a plan is
    // refused here, up front, with the scene named (the server
    // would refuse it with 400 all the same).
    const generateScenes = job.productionPlan.scenes.map(
      (scene, index) => ({ index, prompt: scene.prompt })
    );
    const overlongScene = generateScenes.find(
      (scene) =>
        typeof scene.prompt !== "string" ||
        scene.prompt.length < 1 ||
        scene.prompt.length > 2000
    );
    if (overlongScene) {
      // 400-class refusal: not a network/server failure, so the
      // catch below must not schedule a job refresh for it.
      httpStatus = 400;
      throw new Error(
        "Scene " + (overlongScene.index + 1) +
        " prompt must be between 1 and 2,000 characters. " +
        "Please shorten your video description and try again."
      );
    }
    const response = await fetch(
      "/api/generate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-NOVA-JOB-TOKEN": job.accessToken
        },
        body: JSON.stringify({
          jobId: job.id,
          mode: "plan",
          scenes: generateScenes,
          model: "ltx-video-2b",
          frames: 121,
          resolution: "1024x576",
          fps: 24
        })
      }
    );

    httpStatus = response.status;

    const result = await response.json();

    novaMotionJob = result;

    // Phase 3: a 503 is the honest capacity response (Rev 2 §4.2/§6.4)
    // — no job record is created and there is no "unavailable" job to
    // keep. The message is surfaced to the user as the failure.
    if (!response.ok) {
      throw new Error(
        result.message || "The production request was not accepted."
      );
    }

    novaMotionPendingJobId = null;

    novaUpdateJob(job.id, {
      status: result.status || "queued",
      provider: result.provider || null,
      error: null
    });

    updateMotionStatus(
      result.message || "Production request accepted.",
      result.status || "queued"
    );

    if (result.videoUrl || result.downloadUrl) {
      displayMotionVideo(result.videoUrl || result.downloadUrl);
    }

    // Verify the persistent server record after the visibility window.
    novaScheduleJobRefresh(job.id);

    if (button) {
      button.textContent =
        result.status === "completed"
          ? "Generate Again"
          : "Retry Generation →";
    }

  } catch (error) {
    // A network error or server error may occur after the job was saved.
    // Preserve the ID and token so a retry uses the same credentials.
    if (httpStatus === 0 || httpStatus >= 500) {
      novaMotionPendingJobId = job.id;
    } else {
      novaMotionPendingJobId = null;
    }

    novaUpdateJob(job.id, {
      error: error.message || "Production request failed."
    });

    updateMotionStatus(
      error.message || "Production request failed.",
      "failed"
    );

    if (httpStatus === 0 || httpStatus >= 500) {
      novaScheduleJobRefresh(job.id);
    }

    if (button) {
      button.textContent = "Retry Generation →";
    }

  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

function displayMotionVideo(videoUrl) {
  const preview = document.getElementById("motionPreview");

  if (!preview || !videoUrl) return;

  preview.replaceChildren();

  const video = document.createElement("video");

  video.src = videoUrl;
  video.controls = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.style.width = "100%";
  video.style.borderRadius = "12px";

  preview.appendChild(video);

  updateMotionStatus("Video generation completed.", "completed");
}


/* =========================================
   NOVA MOTION CORE — Stage 3.1
   NOVA-owned jobs, independent of any provider.
   External models execute jobs for NOVA;
   they do not define what NOVA is.
========================================= */

const NOVA_JOBS_KEY = "nova-motion-jobs";
const NOVA_PROJECTS_KEY = "nova-motion-projects";
const NOVA_CHARACTERS_KEY = "nova-motion-characters";
const NOVA_IMAGE_DB = "nova-motion-assets";

function novaNewId(prefix) {
  const unique =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  return prefix + "-" + unique;
}

/* ---------- Job Storage (localStorage for records) ---------- */

function novaLoadJobs() {
  try {
    const raw = localStorage.getItem(NOVA_JOBS_KEY);
    const jobs = raw ? JSON.parse(raw) : [];
    return Array.isArray(jobs) ? jobs : [];
  } catch (error) {
    return [];
  }
}

function novaSaveJobs(jobs) {
  try {
    localStorage.setItem(NOVA_JOBS_KEY, JSON.stringify(jobs));
    return true;
  } catch (error) {
    return false;
  }
}

function novaSaveJob(job) {
  const jobs = novaLoadJobs();
  const index = jobs.findIndex(item => item.id === job.id);
  if (index >= 0) {
    jobs[index] = job;
  } else {
    jobs.unshift(job);
  }
  novaSaveJobs(jobs);
  novaRenderJobs();
  return job;
}

function novaGetJob(id) {
  return novaLoadJobs().find(item => item.id === id) || null;
}

/* ---------- Project and Character Memory Storage (Stage 3.4A) ---------- */

function novaLoadProjects() {
  try {
    const raw = localStorage.getItem(NOVA_PROJECTS_KEY);
    const projects = raw ? JSON.parse(raw) : [];
    return Array.isArray(projects) ? projects : [];
  } catch (error) {
    return [];
  }
}

function novaSaveProjects(projects) {
  try {
    if (!Array.isArray(projects)) return false;
    localStorage.setItem(NOVA_PROJECTS_KEY, JSON.stringify(projects));
    return true;
  } catch (error) {
    return false;
  }
}

function novaGetProject(id) {
  return novaLoadProjects().find(item => item.id === id) || null;
}

function novaSaveProject(project) {
  if (!project || typeof project.id !== "string") return false;

  const projects = novaLoadProjects();
  const index = projects.findIndex(item => item.id === project.id);

  if (index >= 0) {
    projects[index] = project;
  } else {
    projects.unshift(project);
  }

  return novaSaveProjects(projects);
}

function novaCreateProject(name, description = "", visualStyle) {
  const cleanName = typeof name === "string" ? name.trim() : "";

  if (!cleanName) return null;

  const now = new Date().toISOString();

  const project = {
    id: novaNewId("nova-project"),
    name: cleanName,
    description: typeof description === "string" ? description.trim() : "",
    createdAt: now,
    updatedAt: null,
    characterIds: [],
    continuity: {
      worldDescription: "",
      visualStyle: "",
      rules: [],
      notes: []
    }
  };

  // Stage 3.5A: the visual style record. Two-argument calls
  // (and invalid values) yield the photorealistic-human
  // default; novaCreateProject itself persists the preset.
  project.continuity.visualStyle = novaCoerceVisualStyle(visualStyle);

  return novaSaveProject(project) ? project : null;
}

function novaUpdateProject(id, patch) {
  if (!id || !patch || typeof patch !== "object" || Array.isArray(patch)) {
    return null;
  }

  const project = novaGetProject(id);
  if (!project) return null;

  const updated = {
    ...project,
    ...patch,
    id: project.id,
    createdAt: project.createdAt,
    updatedAt: new Date().toISOString()
  };

  // Stage 3.5B: the canon version (Section 16.2)
  // increments on every save changing anything the
  // checks read (continuity fields, objects, locations,
  // visual style) — not on name/description edits.
  if (novaContinuityCanonChanged(project.continuity, updated.continuity)) {
    updated.canonVersion = novaGetProjectCanonVersion(project) + 1;
  }

  if (!novaSaveProject(updated)) return null;

  return updated;
}

/* ---------- Character Memory Storage (Stage 3.4A) ---------- */

function novaLoadCharacters() {
  try {
    const raw = localStorage.getItem(NOVA_CHARACTERS_KEY);
    const characters = raw ? JSON.parse(raw) : [];
    return Array.isArray(characters) ? characters : [];
  } catch (error) {
    return [];
  }
}

function novaSaveCharacters(characters) {
  try {
    if (!Array.isArray(characters)) return false;
    localStorage.setItem(NOVA_CHARACTERS_KEY, JSON.stringify(characters));
    return true;
  } catch (error) {
    return false;
  }
}

function novaGetCharacter(id) {
  return novaLoadCharacters().find(item => item.id === id) || null;
}

function novaSaveCharacter(character) {
  if (!character || typeof character.id !== "string") return false;

  const characters = novaLoadCharacters();
  const index = characters.findIndex(item => item.id === character.id);

  if (index >= 0) {
    characters[index] = character;
  } else {
    characters.unshift(character);
  }

  return novaSaveCharacters(characters);
}

function novaCreateCharacter(projectId, details = {}) {
  const project = novaGetProject(projectId);

  if (!project || !details || typeof details !== "object") {
    return null;
  }

  const now = new Date().toISOString();

  const character = {
    id: novaNewId("nova-char"),
    projectId: project.id,
    name: typeof details.name === "string" ? details.name.trim() : "",
    description: typeof details.description === "string"
      ? details.description
      : "",
    appearance: {
      species: details.appearance?.species || "",
      colors: details.appearance?.colors || "",
      distinctiveFeatures: details.appearance?.distinctiveFeatures || "",
      permanentDetails: Array.isArray(details.appearance?.permanentDetails)
        ? details.appearance.permanentDetails
        : [],
      wardrobe: details.appearance?.wardrobe || "",
      hair: details.appearance?.hair || "",
      accessories: Array.isArray(details.appearance?.accessories)
        ? details.appearance.accessories
        : []
    },
    imageAssetId: details.imageAssetId || null,
    continuityNotes: Array.isArray(details.continuityNotes)
      ? details.continuityNotes
      : [],
    version: 1,
    createdAt: now,
    updatedAt: null
  };

  if (!novaSaveCharacter(character)) return null;

  const characterIds = Array.isArray(project.characterIds)
    ? project.characterIds
    : [];

  if (!characterIds.includes(character.id)) {
    const updatedProject = {
      ...project,
      characterIds: [...characterIds, character.id],
      updatedAt: new Date().toISOString()
    };

    if (!novaSaveProject(updatedProject)) {
      const characters = novaLoadCharacters().filter(
        item => item.id !== character.id
      );
      novaSaveCharacters(characters);
      return null;
    }
  }

  return character;
}

function novaUpdateCharacter(id, patch) {
  if (!id || !patch || typeof patch !== "object" || Array.isArray(patch)) {
    return null;
  }

  const character = novaGetCharacter(id);
  if (!character) return null;

  const updated = {
    ...character,
    ...patch,
    id: character.id,
    projectId: character.projectId,
    createdAt: character.createdAt,
    updatedAt: new Date().toISOString(),
    version: (character.version || 1) + 1
  };

  // Stage 3.5B: an appearance change bumps the OWNING
  // project's canon version (Section 16.2) — the checks
  // read the character's appearance, so a wardrobe or
  // hair change invalidates the plan's decisions
  // watermark.
  if (novaAppearanceCanonChanged(character.appearance, updated.appearance)) {
    const owning = novaGetProject(character.projectId);
    if (owning) {
      owning.canonVersion = novaGetProjectCanonVersion(owning) + 1;
      owning.updatedAt = new Date().toISOString();
      novaSaveProject(owning);
    }
  }

  if (!novaSaveCharacter(updated)) return null;

  return updated;
}

function novaUpdateJob(id, patch) {
  const job = novaGetJob(id);
  if (!job) return null;
  Object.assign(job, patch);
  job.updatedAt = new Date().toISOString();
  return novaSaveJob(job);
}

function novaWait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function novaSyncJobFromServer(jobId) {
  const localJob = novaGetJob(jobId);

  if (
    !localJob ||
    !localJob.accessToken
  ) {
    return false;
  }

  // The first check waits for the observed Blobs visibility delay.
  const retryDelays = [0, 2000, 4000, 8000, 12000, 16000];

  for (let attempt = 0; attempt < retryDelays.length; attempt++) {
    if (retryDelays[attempt] > 0) {
      await novaWait(retryDelays[attempt]);
    }

    try {
      const response = await fetch(
        "/api/status?jobId=" +
          encodeURIComponent(jobId),
        {
          method: "GET",
          headers: {
            "X-NOVA-JOB-TOKEN": localJob.accessToken
          }
        }
      );

      const data = await response.json();

      // Phase 3 retarget (Rev 2 §4.1, 25 Nov 2026): /api/status
      // replaces /api/motion-status. A 404 here means the job is
      // unknown to the Worker (no Blobs visibility delay exists on
      // this route); the short retry loop below is kept only as a
      // guard for a status check issued immediately after creation.
      if (response.status === 404) {
        continue;
      }

      if (response.status === 401) {
        novaUpdateJob(jobId, {
          error: "NOVA could not authenticate this saved job."
        });
        return false;
      }

      if (!response.ok) {
        throw new Error(
          data.message || "Could not retrieve the saved job."
        );
      }

      if (data.jobId !== jobId) {
        throw new Error("The server returned an unexpected job.");
      }

      const currentJob = novaGetJob(jobId);

      if (!currentJob) {
        return false;
      }

      // Preserve local scene metadata while applying server statuses.
      // Phase 3 (/api/status) scene entries carry status, error,
      // expiresAt, retrying and downloadUrl (not the old videoUrl /
      // providerJobId); the executionId is kept on the local scene
      // for reference. Fields the server no longer reports keep
      // their local values instead of being cleared.
      const serverScenes = Array.isArray(data.scenes)
        ? data.scenes
        : [];

      const mergedScenes = currentJob.scenes.map(localScene => {
        const serverScene = serverScenes.find(
          scene => scene.index === localScene.index
        );

        if (!serverScene) {
          return localScene;
        }

        return Object.assign({}, localScene, {
          status: serverScene.status,
          providerJobId: serverScene.providerJobId || localScene.providerJobId || null,
          executionId: serverScene.executionId || localScene.executionId || null,
          videoUrl: serverScene.downloadUrl || serverScene.videoUrl || localScene.videoUrl || null,
          error: serverScene.error || null
        });
      });

      novaUpdateJob(jobId, {
        status: data.status,
        provider: data.provider || currentJob.provider,
        updatedAt: data.updatedAt,
        productionPlan: data.plan || currentJob.productionPlan,
        scenes: mergedScenes,
        error: data.error || null
      });

      return true;

    } catch (error) {
      console.error(
        "[NOVA MOTION] Status retrieval error:",
        error
      );

      novaUpdateJob(jobId, {
        error: error.message || "Status retrieval failed."
      });

      return false;
    }
  }

  // Do not mark a job failed just because the server has not
  // reported it yet (e.g. a status check issued immediately after
  // creation). The local job stays saved and retryable.
  novaUpdateJob(jobId, {
    error:
      "The saved job is not visible yet. NOVA will check again later."
  });

  return false;
}

function novaScheduleJobRefresh(jobId) {
  setTimeout(() => {
    novaSyncJobFromServer(jobId);
  }, 12000);
}

function novaRestoreJobs() {
  const jobs = novaLoadJobs();

  jobs.forEach(job => {
    if (
      job &&
      job.id &&
      job.accessToken
    ) {
      novaScheduleJobRefresh(job.id);
    }
  });
}

/* ---------- Legacy Character Migration (Stage 3.4B) ---------- */

// Produces a stable identity key from the actual character description
// and image asset reference. The old characterRef ID is deliberately ignored.
function novaLegacyCharacterMigrationKey(characterRef) {
  if (!characterRef || typeof characterRef.description !== "string") {
    return null;
  }

  const description = characterRef.description
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

  if (!description) return null;

  const imageAssetId =
    typeof characterRef.imageAssetId === "string" &&
    characterRef.imageAssetId.trim()
      ? characterRef.imageAssetId
      : null;

  return JSON.stringify([description, imageAssetId]);
}

// Detects a relationship conflict for one recovered character identity.
// Returns null when the existing records agree, or a conflict object
// naming the competing projects when they do not. A conflict exists when:
// - two or more projects carry the group's migration key (even with no
//   character record: migration would otherwise select the first and
//   leave another project claiming the same identity);
// - the character's linked project already carries a different
//   non-empty migration key (it belongs to another identity);
// - the character's recorded project and the project identified
//   independently by the migration key disagree (two live projects
//   claim the identity, or the character's link names a missing project
//   while the key names a live one).
// Migration must never silently choose between them.
function novaLegacyCharacterRelationshipConflict(group, characters, projects) {
  const character = characters.find(
    item => item && item.legacyMigrationKey === group.key
  );

  const keyProjects = projects.filter(
    item => item && item.legacyMigrationKey === group.key
  );

  const linkedProject = character
    ? projects.find(item => item && item.id === character.projectId)
    : null;

  const linkedProjectKey =
    linkedProject &&
    typeof linkedProject.legacyMigrationKey === "string" &&
    linkedProject.legacyMigrationKey.trim()
      ? linkedProject.legacyMigrationKey
      : null;

  // Duplicate key-bearing projects are a conflict even when no
  // character record exists.
  if (keyProjects.length > 1) {
    return {
      description: group.description,
      imageAssetId: group.imageAssetId,
      jobIds: group.jobIds,
      characterId: character ? character.id : null,
      linkedProjectId: linkedProject ? linkedProject.id : null,
      keyProjectIds: keyProjects.map(project => project.id),
      linkedProjectKey
    };
  }

  if (!character) return null;

  // The linked project already belongs to another recovered identity:
  // it must not be silently reused for this one.
  if (linkedProjectKey && linkedProjectKey !== group.key) {
    return {
      description: group.description,
      imageAssetId: group.imageAssetId,
      jobIds: group.jobIds,
      characterId: character.id,
      linkedProjectId: linkedProject.id,
      keyProjectIds: keyProjects.map(project => project.id),
      linkedProjectKey
    };
  }

  if (keyProjects.length === 0) return null;

  // Consistent only when exactly one project carries the key and it is
  // the character's own linked project.
  if (
    linkedProject &&
    keyProjects.length === 1 &&
    keyProjects[0].id === linkedProject.id
  ) {
    return null;
  }

  return {
    description: group.description,
    imageAssetId: group.imageAssetId,
    jobIds: group.jobIds,
    characterId: character.id,
    linkedProjectId: linkedProject ? linkedProject.id : null,
    keyProjectIds: keyProjects.map(project => project.id),
    linkedProjectKey
  };
}

// Creates a read-only migration report.
// This function does not write to localStorage or IndexedDB.
function novaPreviewLegacyCharacterMigration() {
  try {
    const jobs = novaLoadJobs();
    const projects = novaLoadProjects();
    const characters = novaLoadCharacters();

    const groups = new Map();

    const skipped = {
      alreadyLinked: 0,
      missingCharacterRef: 0,
      missingDescription: 0
    };

    jobs.forEach(job => {
      if (!job || !job.id) return;

      if (job.projectId) {
        skipped.alreadyLinked++;
        return;
      }

      if (!job.characterRef) {
        skipped.missingCharacterRef++;
        return;
      }

      const key = novaLegacyCharacterMigrationKey(job.characterRef);

      if (!key) {
        skipped.missingDescription++;
        return;
      }

      if (!groups.has(key)) {
        groups.set(key, {
          key,
          description: job.characterRef.description.trim(),
          imageAssetId: job.characterRef.imageAssetId || null,
          jobIds: []
        });
      }

      groups.get(key).jobIds.push(job.id);
    });

    const reportGroups = Array.from(groups.values()).map(group => {
      const existingCharacter = characters.find(
        character =>
          character &&
          character.legacyMigrationKey === group.key
      );

      const linkedProject = existingCharacter
        ? projects.find(
            project => project && project.id === existingCharacter.projectId
          )
        : null;

      // A project is found independently by migration key, so an
      // interrupted run that saved the project but not the character
      // is still detected and reused.
      const keyProject = projects.find(
        project =>
          project &&
          project.legacyMigrationKey === group.key
      );

      // Prefer the character's own project link when it resolves.
      const existingProject = linkedProject || keyProject || null;

      // A conflicted group is reported explicitly, never presented as
      // an ordinary reusable record.
      const conflict = novaLegacyCharacterRelationshipConflict(
        group,
        characters,
        projects
      );

      return {
        description: group.description,
        imageAssetId: group.imageAssetId,
        jobIds: group.jobIds,
        jobCount: group.jobIds.length,
        existingCharacterId: existingCharacter
          ? existingCharacter.id
          : null,
        existingProjectId: conflict
          ? (linkedProject ? linkedProject.id : null)
          : (existingProject ? existingProject.id : null),
        projectRequired: !existingProject,
        characterRequired: !existingCharacter,
        conflict
      };
    });

    return {
      ok: true,
      dryRun: true,
      totalJobs: jobs.length,
      eligibleJobs: reportGroups.reduce(
        (total, group) => total + group.jobCount,
        0
      ),
      distinctCharacterGroups: reportGroups.length,
      newProjectsRequired: reportGroups.filter(
        group => group.projectRequired
      ).length,
      newCharactersRequired: reportGroups.filter(
        group => group.characterRequired
      ).length,
      skipped,
      conflicts: reportGroups
        .filter(group => group.conflict)
        .map(group => group.conflict),
      groups: reportGroups
    };
  } catch (error) {
    return {
      ok: false,
      dryRun: true,
      error: error.message || "Migration preview failed."
    };
  }
}

// Executes migration only when explicitly called.
// Existing jobs, access tokens, plans, scenes and characterRef objects
// are preserved. No IndexedDB image data is modified.
function novaMigrateLegacyCharacters() {
  const preview = novaPreviewLegacyCharacterMigration();

  if (!preview.ok) return preview;

  // A relationship conflict means the stored records disagree about
  // which project a character belongs to. Abort before writing
  // anything — NOVA must not silently choose between them.
  if (preview.conflicts && preview.conflicts.length > 0) {
    return {
      ok: false,
      migrated: false,
      error: "Migration aborted: " + preview.conflicts.length +
        " character project relationship conflict(s) must be resolved before migration can run.",
      conflicts: preview.conflicts,
      preview
    };
  }

  if (preview.eligibleJobs === 0) {
    return {
      ok: true,
      migrated: false,
      message: "No eligible legacy character jobs were found.",
      preview
    };
  }

  const originalProjectRaw = localStorage.getItem(NOVA_PROJECTS_KEY);
  const originalCharacterRaw = localStorage.getItem(NOVA_CHARACTERS_KEY);
  const originalJobsRaw = localStorage.getItem(NOVA_JOBS_KEY);

  try {
    const projects = novaLoadProjects();
    const characters = novaLoadCharacters();
    const jobs = novaLoadJobs();

    let migratedJobs = 0;
    let createdProjects = 0;
    let createdCharacters = 0;
    let reusedProjects = 0;
    let reusedCharacters = 0;

    const groups = new Map();

    jobs.forEach(job => {
      if (!job || !job.id || job.projectId || !job.characterRef) {
        return;
      }

      const key = novaLegacyCharacterMigrationKey(job.characterRef);

      if (!key) return;

      if (!groups.has(key)) {
        groups.set(key, {
          key,
          description: job.characterRef.description.trim(),
          imageAssetId: job.characterRef.imageAssetId || null,
          jobIds: []
        });
      }

      groups.get(key).jobIds.push(job.id);
    });

    for (const group of groups.values()) {
      let character = characters.find(
        item => item && item.legacyMigrationKey === group.key
      );

      // A project is found independently by migration key, so an
      // interrupted run that saved the project but not the character
      // is still detected and reused instead of duplicated.
      let project = projects.find(
        item => item && item.legacyMigrationKey === group.key
      );

      // Prefer the character's own project link when it resolves.
      if (character) {
        const linkedProject = projects.find(
          item => item && item.id === character.projectId
        );
        if (linkedProject) project = linkedProject;
      }

      const now = new Date().toISOString();

      // Create only the project when it is missing. When a character
      // already exists, the recovered project keeps the character's
      // original project ID and creation time.
      if (!project) {
        project = {
          id: character ? character.projectId : novaNewId("nova-project"),
          name: "Recovered: " + group.description.slice(0, 70),
          description: "Automatically recovered from existing NOVA production jobs.",
          createdAt: character && character.createdAt ? character.createdAt : now,
          updatedAt: null,
          characterIds: [],
          continuity: {
            worldDescription: "",
            visualStyle: "",
            rules: [],
            notes: []
          },
          legacyMigrationKey: group.key
        };

        projects.unshift(project);
        createdProjects++;
      } else {
        reusedProjects++;
      }

      // A reused linked project may predate migration keys. Assign the
      // group's key so post-persistence verification can find it and a
      // later run recognises the project as recovered. Its ID, creation
      // date and existing character relationships are preserved. The
      // write-back is unconditional: the linking block below only writes
      // the project back when the character is newly added, so without
      // this the key would be lost whenever the character was already
      // listed in characterIds.
      // A whitespace-only key counts as missing, matching the detector's
      // trimmed-string treatment: otherwise verification would fail on
      // the malformed key and roll the migration back.
      const hasMigrationKey =
        typeof project.legacyMigrationKey === "string" &&
        project.legacyMigrationKey.trim();

      if (!hasMigrationKey) {
        project = { ...project, legacyMigrationKey: group.key };

        const projectIndex = projects.findIndex(
          item => item.id === project.id
        );

        if (projectIndex >= 0) {
          projects[projectIndex] = project;
        } else {
          projects.unshift(project);
        }
      }

      // Create only the character when it is missing, linked to the
      // (possibly reused) project recovered above.
      if (!character) {
        character = {
          id: novaNewId("nova-char"),
          projectId: project.id,
          name: "Recovered Character",
          description: group.description,
          appearance: {
            species: "",
            colors: "",
            distinctiveFeatures: "",
            permanentDetails: []
          },
          imageAssetId: group.imageAssetId,
          continuityNotes: [],
          version: 1,
          createdAt: now,
          updatedAt: null,
          legacyMigrationKey: group.key
        };

        characters.unshift(character);
        createdCharacters++;
      } else {
        // The character's recorded project relationship is preserved
        // as found. A disagreement with the migration key is a
        // conflict, and the migration aborts before reaching this
        // point — it is never silently rewritten here.
        reusedCharacters++;
      }

      const characterIds = Array.isArray(project.characterIds)
        ? project.characterIds
        : [];

      if (!characterIds.includes(character.id)) {
        project = {
          ...project,
          characterIds: [...characterIds, character.id]
        };

        const projectIndex = projects.findIndex(
          item => item.id === project.id
        );

        if (projectIndex >= 0) {
          projects[projectIndex] = project;
        } else {
          projects.unshift(project);
        }
      }

      const continuitySnapshot = JSON.parse(
        JSON.stringify(project.continuity || {
          worldDescription: "",
          visualStyle: "",
          rules: [],
          notes: []
        })
      );

      const characterSnapshot = JSON.parse(
        JSON.stringify(character)
      );

      group.jobIds.forEach(jobId => {
        const jobIndex = jobs.findIndex(item => item && item.id === jobId);

        if (jobIndex < 0) return;

        const job = jobs[jobIndex];

        // Never overwrite an existing project relationship.
        if (job.projectId) return;

        jobs[jobIndex] = {
          ...job,
          projectId: project.id,
          characterIds: [character.id],
          characterSnapshots: [characterSnapshot],
          continuitySnapshot
        };

        migratedJobs++;
      });
    }

    // Persist all three collections. If any write fails, restore
    // their original raw values rather than leaving a partial migration.
    localStorage.setItem(NOVA_PROJECTS_KEY, JSON.stringify(projects));
    localStorage.setItem(NOVA_CHARACTERS_KEY, JSON.stringify(characters));
    localStorage.setItem(NOVA_JOBS_KEY, JSON.stringify(jobs));

    // Verify the persisted collections before reporting success.
    const savedProjects = JSON.parse(
      localStorage.getItem(NOVA_PROJECTS_KEY) || "[]"
    );
    const savedCharacters = JSON.parse(
      localStorage.getItem(NOVA_CHARACTERS_KEY) || "[]"
    );
    const savedJobs = JSON.parse(
      localStorage.getItem(NOVA_JOBS_KEY) || "[]"
    );

    if (
      !Array.isArray(savedProjects) ||
      !Array.isArray(savedCharacters) ||
      !Array.isArray(savedJobs) ||
      savedJobs.length !== jobs.length ||
      savedProjects.length !== projects.length ||
      savedCharacters.length !== characters.length
    ) {
      throw new Error("Migration persistence verification failed.");
    }

    // Verify every migrated project-character relationship survived
    // persistence: the character must exist, its project must exist,
    // the character must point at that project, and the project must
    // list the character.
    for (const group of groups.values()) {
      const savedCharacter = savedCharacters.find(
        item => item && item.legacyMigrationKey === group.key
      );
      const savedProject = savedProjects.find(
        item => item && item.legacyMigrationKey === group.key
      );

      if (
        !savedCharacter ||
        !savedProject ||
        savedCharacter.projectId !== savedProject.id ||
        !Array.isArray(savedProject.characterIds) ||
        !savedProject.characterIds.includes(savedCharacter.id)
      ) {
        throw new Error("Migration relationship verification failed.");
      }
    }

    novaRenderJobs();

    return {
      ok: true,
      migrated: true,
      migratedJobs,
      createdProjects,
      createdCharacters,
      reusedProjects,
      reusedCharacters,
      skipped: preview.skipped
    };
  } catch (error) {
    // Restore the exact original values, including absent keys.
    try {
      if (originalProjectRaw === null) {
        localStorage.removeItem(NOVA_PROJECTS_KEY);
      } else {
        localStorage.setItem(NOVA_PROJECTS_KEY, originalProjectRaw);
      }

      if (originalCharacterRaw === null) {
        localStorage.removeItem(NOVA_CHARACTERS_KEY);
      } else {
        localStorage.setItem(NOVA_CHARACTERS_KEY, originalCharacterRaw);
      }

      if (originalJobsRaw === null) {
        localStorage.removeItem(NOVA_JOBS_KEY);
      } else {
        localStorage.setItem(NOVA_JOBS_KEY, originalJobsRaw);
      }
    } catch (rollbackError) {
      return {
        ok: false,
        migrated: false,
        error: "Migration failed and automatic rollback also encountered a storage error. Do not retry until storage has been inspected.",
        rollbackError: rollbackError.message || "Unknown rollback error."
      };
    }

    return {
      ok: false,
      migrated: false,
      error: error.message || "Migration failed. Original records were restored."
    };
  }
}

/* ---------- Image assets (IndexedDB — never localStorage) ----------
   Job records hold image metadata + an asset id only. The actual image
   bytes live in IndexedDB, so a large reference image cannot blow the
   localStorage quota. If asset storage fails, the job is still created
   with metadata only — storage failure never blocks job creation. */

function novaOpenImageDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(NOVA_IMAGE_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("images")) {
        request.result.createObjectStore("images");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function novaStoreImage(file) {
  if (!file) return null;
  const assetId = novaNewId("nova-img");
  try {
    const db = await novaOpenImageDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("images", "readwrite");
      tx.objectStore("images").put(file, assetId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return { id: assetId, name: file.name, type: file.type, size: file.size };
  } catch (error) {
    return {
      id: null,
      name: file.name,
      type: file.type,
      size: file.size,
      stored: false
    };
  }
}

async function novaGetImage(assetId) {
  if (!assetId) return null;
  try {
    const db = await novaOpenImageDB();
    const blob = await new Promise((resolve, reject) => {
      const request = db
        .transaction("images", "readonly")
        .objectStore("images")
        .get(assetId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return blob;
  } catch (error) {
    return null;
  }
}

/* ---------- Scene Executor ----------
   Prepares individual scene execution units from the saved plan.
   The executor NEVER calls a provider — it hands execution units
   to the Provider Interface. */

function novaPrepareScenes(plan, characterRef) {
  return plan.scenes.map((scene, index) => ({
    index,
    title: scene.title,
    prompt: scene.prompt,
    direction: scene.direction,
    camera: scene.camera,
    motion: scene.motion,
    start: scene.start,
    end: scene.end,
    duration: scene.duration,
    status: "queued",
    providerJobId: null,
    videoUrl: null,
    error: null,
    characterRefId: characterRef ? characterRef.id : null
  }));
}

/* ---------- Job Manager ----------
   Correction 1: job creation is separate from provider availability.
   Tap Generate Video -> NOVA creates its job id -> saves the plan ->
   saves the scenes -> THEN checks provider availability. If no
   provider exists, the job becomes "unavailable" — and stays saved
   and accessible. */

function novaCreateAccessToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function novaCreateJob(plan) {
  const imageAsset = novaMotionImageFile
    ? await novaStoreImage(novaMotionImageFile)
    : null;

  const characterRef = {
    id: novaNewId("nova-char"),
    description: plan.character || null,
    imageAssetId: imageAsset && imageAsset.id
      ? imageAsset.id
      : null,
    createdAt: new Date().toISOString()
  };

  const accessToken = novaCreateAccessToken();

  const productionPlan = JSON.parse(JSON.stringify(plan));

  const job = {
    id: novaNewId("nova-job"),
    createdAt: new Date().toISOString(),
    updatedAt: null,
    status: "queued",

    // The complete plan is retained for authenticated submission.
    productionPlan,

    // Existing local plan structure is preserved.
    plan: {
      prompt: plan.prompt,
      character: plan.character,
      mode: plan.mode,
      ratio: plan.ratio,
      duration: plan.duration,
      style: plan.style,
      camera: plan.camera,
      image: imageAsset
        ? {
            name: imageAsset.name,
            type: imageAsset.type,
            size: imageAsset.size,
            assetId: imageAsset.id
          }
        : plan.image || null
    },

    scenes: novaPrepareScenes(plan, characterRef),
    provider: null,
    characterRef,
    accessToken,
    result: null,
    error: null
  };

  novaSaveJob(job);

  // Never submit until the token and job are confirmed in localStorage.
  const persistedJob = novaGetJob(job.id);

  if (
    !persistedJob ||
    persistedJob.accessToken !== accessToken ||
    !persistedJob.productionPlan
  ) {
    throw new Error(
      "NOVA could not securely save the job credentials. Please check browser storage."
    );
  }

  return persistedJob;
}

/* ---------- Project-Aware Job Creation (Stage 3.4C) ----------
   Standalone creation (novaCreateJob) is unchanged. A project job is
   created inside a selected project using a selected character, with
   immutable snapshots of the character and the project's continuity
   at the moment of creation. Editing the character or the project
   later never rewrites an existing job's history.
   Image rules: the character's saved image is the default identity
   reference; a newly uploaded image overrides it for that single
   production and is stored as a separate asset — it never overwrites
   the character's permanent reference image. */

function novaGetProjectSelection() {
  const projectId = novaSelectedProjectId || null;
  const characterId = novaSelectedCharacterId || null;

  if (!projectId && !characterId) return null;

  if (!projectId) {
    throw new Error(
      "A character is selected but no project is selected. Select a project first."
    );
  }

  if (!characterId) {
    throw new Error(
      "A project is selected but no character is selected. Select a character first."
    );
  }

  return { projectId, characterId };
}

function novaBlobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(
      new Error("Could not read the reference image.")
    );

    reader.readAsDataURL(blob);
  });
}

async function novaCreateProjectJob(plan, projectId, characterId) {
  const project = novaGetProject(projectId);

  if (!project) {
    throw new Error("The selected project does not exist.");
  }

  const character = novaGetCharacter(characterId);

  if (!character) {
    throw new Error("The selected character does not exist.");
  }

  // Belonging is decided by the character's own projectId, which
  // novaCreateCharacter sets and novaUpdateCharacter protects.
  // project.characterIds is a maintained mirror, never repaired here.
  if (character.projectId !== project.id) {
    throw new Error(
      "The selected character does not belong to the selected project."
    );
  }

  // Resolve the reference image: a new upload overrides the saved
  // character image for this production only; otherwise the saved
  // image is the default; otherwise the job has no image reference.
  // The character record is never written here, so an upload can
  // never overwrite the character's permanent reference image.
  let imageAsset = null;
  let imageSource = "none";

  if (novaMotionImageFile) {
    const uploaded = await novaStoreImage(novaMotionImageFile);

    if (!uploaded || !uploaded.id) {
      throw new Error(
        "NOVA could not save the uploaded reference image. Please check browser storage."
      );
    }

    imageAsset = {
      id: uploaded.id,
      name: uploaded.name,
      type: uploaded.type,
      size: uploaded.size
    };
    imageSource = "upload";
  } else if (character.imageAssetId) {
    const saved = await novaGetImage(character.imageAssetId);

    if (!saved) {
      throw new Error(
        "The character's saved reference image is no longer available in this browser."
      );
    }

    imageAsset = {
      id: character.imageAssetId,
      name: saved.name || null,
      type: saved.type || null,
      size: typeof saved.size === "number" ? saved.size : null
    };
    imageSource = "saved";
  }

  const accessToken = novaCreateAccessToken();

  // Stage 3.5B: revalidate decisions BEFORE snapshotting
  // (trigger 3, Section 16.2) — a stale decision can never
  // suppress a warning in a created job. The revalidation
  // mutates the plan in place (removes stale decisions,
  // updates the watermark), so the productionPlan copy
  // below and the snapshot both carry post-revalidation
  // decisions. A broken chain blocks creation with the
  // chain's error.
  //
  // A plan that never went through the planner (a legacy
  // plan, or a plan built programmatically) may lack scene
  // ids and continuity fields. Job creation is a plan use:
  // assign ids now — the Section 11 first-open for this
  // plan (collisions repaired first, then assignment, in
  // the fixed order) — and ensure the continuity fields,
  // so the chain can key warnings and decisions. Without
  // this, creation would fail closed on a plan the user
  // could otherwise build.
  novaAssignSceneIds(plan);
  novaEnsurePlanContinuityFields(plan, project);
  const creationCheck = novaRevalidatePlanForCreation(project, plan);
  if (creationCheck.error) {
    throw new Error(creationCheck.error);
  }
  novaLastCreationRevalidation = creationCheck.revalidation;
  const productionContinuity = novaBuildProductionContinuitySnapshot(
    project,
    plan,
    creationCheck.result.chain
  );

  const productionPlan = JSON.parse(JSON.stringify(plan));

  // The job's character reference names the SELECTED character, so
  // scene characterRefIds point at the real character, not a
  // throwaway per-job id.
  const characterRef = {
    id: character.id,
    description: character.description,
    imageAssetId: imageAsset ? imageAsset.id : null,
    createdAt: character.createdAt
  };

  // Stage 3.4E: build the continuity context fresh at creation,
  // so the job snapshot reflects the records at this moment.
  // The validation above already guarantees the context builds;
  // the null guard is defence only.
  const continuityBuilt = novaBuildContinuityContext(
    project.id,
    character.id
  );
  const continuityContext =
    continuityBuilt && continuityBuilt.context
      ? JSON.parse(JSON.stringify(continuityBuilt.context))
      : null;

  const job = {
    id: novaNewId("nova-job"),
    createdAt: new Date().toISOString(),
    updatedAt: null,
    status: "queued",

    // The complete plan is retained for authenticated submission.
    productionPlan,

    // Existing local plan structure is preserved.
    plan: {
      prompt: plan.prompt,
      character: plan.character,
      mode: plan.mode,
      ratio: plan.ratio,
      duration: plan.duration,
      style: plan.style,
      camera: plan.camera,
      image: imageAsset
        ? {
            name: imageAsset.name,
            type: imageAsset.type,
            size: imageAsset.size,
            assetId: imageAsset.id
          }
        : plan.image || null
    },

    scenes: novaPrepareScenes(plan, characterRef),
    provider: null,
    characterRef,
    accessToken,
    result: null,
    error: null,

    projectId: project.id,
    characterIds: [character.id],

    // Immutable snapshots: deep copies of the character and the
    // project's continuity at the moment of creation.
    characterSnapshots: [
      {
        characterId: character.id,
        version: character.version || 1,
        name: character.name,
        description: character.description,
        appearance: JSON.parse(JSON.stringify(character.appearance || {})),
        imageAssetId: imageAsset ? imageAsset.id : null,
        imageSource,
        continuityNotes: JSON.parse(
          JSON.stringify(character.continuityNotes || [])
        )
      }
    ],

    continuitySnapshot: JSON.parse(
      JSON.stringify(
        project.continuity || {
          worldDescription: "",
          visualStyle: "",
          rules: [],
          notes: []
        }
      )
    ),

    // Stage 3.4E: the continuity context used at the moment of
    // creation, built fresh from the current records. Immutable:
    // later edits to the project or character never rewrite it.
    continuityContext,

    // Stage 3.5B: the immutable production continuity snapshot
    // (Section 17) — the full production state at creation,
    // frozen alongside continuitySnapshot + continuityContext.
    productionContinuity
  };

  novaSaveJob(job);

  // Never submit until the token and job are confirmed in localStorage.
  const persistedJob = novaGetJob(job.id);

  if (
    !persistedJob ||
    persistedJob.accessToken !== accessToken ||
    !persistedJob.productionPlan ||
    !persistedJob.characterSnapshots ||
    !persistedJob.continuitySnapshot ||
    !persistedJob.productionContinuity
  ) {
    throw new Error(
      "NOVA could not securely save the job credentials. Please check browser storage."
    );
  }

  return persistedJob;
}

/* =====================================================================
   NOVA MOTION — Stage 3.4D: Project Workspace UI
   ---------------------------------------------------------------------
   User-facing management for the Stage 3.4A project/character memory
   foundation, integrated with the Stage 3.4C production system.

   Views render into #workspaceBody and switch on novaWorkspaceView:
   "projects" (list), "projectForm" (create/edit project),
   "project" (detail: characters + continuity editor),
   "characterForm" (create/edit character).

   Data protection rules:
   - A project or character referenced by ANY production job can
     never be deleted. Its identity is part of production history.
   - A project with ANY characters cannot be deleted (no cascade).
     Delete its characters first.
   - Deleting an unreferenced character or an empty project needs
     an inline two-step confirmation (no confirm() dialogs).
   - Replacing a character image only changes the character record.
     Image assets are never deleted from IndexedDB, so historical
     job snapshots keep resolving.
   - Archive is a plain `archived` flag on the project record.
     Archived projects are hidden from the list (unless toggled)
     and from the Motion Studio selectors.
   - All persistence goes through the Stage 3.4A helpers; all
     production goes through novaCreateJob / novaCreateProjectJob.
   ===================================================================== */

let novaWorkspaceView = "projects";
let novaWorkspaceProjectId = null;
let novaWorkspaceCharacterId = null;
let novaWorkspaceDeleteTarget = null;
let novaWorkspaceShowArchived = false;

function openProjectWorkspace() {
  novaWorkspaceView = "projects";
  novaWorkspaceProjectId = null;
  novaWorkspaceCharacterId = null;
  novaWorkspaceDeleteTarget = null;
  document.getElementById("projectWorkspace").style.display = "block";
  document.body.style.overflow = "hidden";
  document.getElementById("sidebar").classList.remove("open");
  novaRenderWorkspace();
}

function closeProjectWorkspace() {
  document.getElementById("projectWorkspace").style.display = "none";
  document.body.style.overflow = "";
}

function novaOpenWorkspaceFromMotion() {
  closeMotionStudio();
  openProjectWorkspace();
}

function novaWorkspaceSetStatus(message) {
  const status = document.getElementById("workspaceStatus");
  if (status) status.textContent = message || "";
}

function novaWorkspaceLines(text) {
  return String(text || "")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

function novaWorkspaceJobsForProject(projectId) {
  return novaLoadJobs().filter(job => job.projectId === projectId);
}

function novaWorkspaceJobsForCharacter(characterId) {
  return novaLoadJobs().filter(job =>
    (Array.isArray(job.characterIds) &&
      job.characterIds.includes(characterId)) ||
    (Array.isArray(job.characterSnapshots) &&
      job.characterSnapshots.some(
        snapshot => snapshot.characterId === characterId
      )) ||
    (job.characterRef && job.characterRef.id === characterId)
  );
}

function novaWorkspaceLoadImageInto(elementId, assetId) {
  novaGetImage(assetId)
    .then(blob => {
      const element = document.getElementById(elementId);
      if (!element || !blob) return;
      element.innerHTML =
        `<img src="${URL.createObjectURL(blob)}" ` +
        `alt="Character reference" class="ws-thumb-img">`;
    })
    .catch(() => {});
}

function novaRenderWorkspace() {
  const body = document.getElementById("workspaceBody");
  if (!body) return;

  if (novaWorkspaceView === "projectForm") {
    body.innerHTML = novaWorkspaceProjectFormHtml();
  } else if (novaWorkspaceView === "project") {
    body.innerHTML = novaWorkspaceProjectDetailHtml();
    novaWorkspaceLoadDetailImages();
  } else if (novaWorkspaceView === "characterForm") {
    body.innerHTML = novaWorkspaceCharacterFormHtml();
    novaWorkspaceLoadCharacterFormImage();
  } else {
    body.innerHTML = novaWorkspaceProjectsHtml();
  }
}

function novaWorkspaceDeleteConfirmHtml(type, id, text) {
  const confirmFn =
    type === "project"
      ? "novaWorkspaceConfirmDeleteProject"
      : "novaWorkspaceConfirmDeleteCharacter";
  return `<div class="ws-confirm">
    <p>${novaEscape(text)}</p>
    <div class="ws-row">
      <button type="button" class="ws-btn ws-btn-danger" data-nova-click="${confirmFn}" data-nova-arg="${id}">Delete</button>
      <button type="button" class="ws-btn" data-nova-click="novaWorkspaceCancelDelete">Cancel</button>
    </div>
  </div>`;
}

function novaWorkspaceProjectsHtml() {
  const projects = novaLoadProjects();
  const visible = novaWorkspaceShowArchived
    ? projects
    : projects.filter(project => !project.archived);
  const archivedCount = projects.filter(project => project.archived).length;

  let cards = "";
  if (!visible.length) {
    cards = `<p class="motion-note">No projects yet. Create your first project to start building characters and worlds.</p>`;
  } else {
    cards = visible
      .map(project => {
        const characters = novaLoadCharacters().filter(
          character => character.projectId === project.id
        );
        const jobs = novaWorkspaceJobsForProject(project.id);
        const confirming =
          novaWorkspaceDeleteTarget &&
          novaWorkspaceDeleteTarget.type === "project" &&
          novaWorkspaceDeleteTarget.id === project.id;
        return `<div class="ws-card">
        <h3>${novaEscape(project.name)}</h3>
        <p class="ws-text">${novaEscape(project.description || "")}</p>
        <p class="motion-note">${characters.length} character${characters.length === 1 ? "" : "s"} · ${jobs.length} production job${jobs.length === 1 ? "" : "s"}${project.archived ? " · Archived" : ""}</p>
        <div class="ws-row">
          <button type="button" class="ws-btn" data-nova-click="novaWorkspaceOpenProject" data-nova-arg="${project.id}">Open</button>
          <button type="button" class="ws-btn" data-nova-click="novaWorkspaceEditProject" data-nova-arg="${project.id}">Edit</button>
          ${project.archived
            ? `<button type="button" class="ws-btn" data-nova-click="novaWorkspaceUnarchiveProject" data-nova-arg="${project.id}">Unarchive</button>`
            : `<button type="button" class="ws-btn" data-nova-click="novaWorkspaceArchiveProject" data-nova-arg="${project.id}">Archive</button>`}
          <button type="button" class="ws-btn ws-btn-danger" data-nova-click="novaWorkspaceAskDeleteProject" data-nova-arg="${project.id}">Delete</button>
        </div>
        ${confirming ? novaWorkspaceDeleteConfirmHtml("project", project.id, "Delete this project? This cannot be undone.") : ""}
      </div>`;
      })
      .join("");
  }

  return `<section class="motion-panel">
    <h2>📁 Projects</h2>
    <p class="motion-note">Projects hold your characters, worlds and production history. Archived projects are hidden from Motion Studio.</p>
    <div class="ws-row">
      <button type="button" class="ws-btn ws-btn-primary" data-nova-click="novaWorkspaceNewProject">+ New Project</button>
      ${archivedCount ? `<button type="button" class="ws-btn" data-nova-click="novaWorkspaceToggleArchived">${novaWorkspaceShowArchived ? "Hide archived" : "Show archived (" + archivedCount + ")"}</button>` : ""}
    </div>
    <div class="ws-grid">${cards}</div>
  </section>`;
}

function novaWorkspaceProjectFormHtml() {
  const editing = novaWorkspaceProjectId
    ? novaGetProject(novaWorkspaceProjectId)
    : null;
  return `<section class="motion-panel">
    <h2>${editing ? "Edit Project" : "New Project"}</h2>
    <label class="motion-label" for="wsProjectName">Project name</label>
    <input class="motion-input" id="wsProjectName" type="text" value="${editing ? novaEscape(editing.name) : ""}" placeholder="Example: Ashfall — Fantasy Film Universe">
    <label class="motion-label" for="wsProjectDescription">Description</label>
    <textarea class="motion-input" id="wsProjectDescription" rows="3" placeholder="What is this project about?">${editing ? novaEscape(editing.description || "") : ""}</textarea>
    ${editing ? "" : novaStylePickerHtml("photorealistic-human", "", "wsNewStyle", false)}
    <div class="ws-row">
      <button type="button" class="ws-btn ws-btn-primary" data-nova-click="novaWorkspaceSaveProject">Save Project</button>
      <button type="button" class="ws-btn" data-nova-click="novaWorkspaceBackToProjects">Cancel</button>
    </div>
  </section>`;
}

function novaWorkspaceProjectDetailHtml() {
  const project = novaGetProject(novaWorkspaceProjectId);
  if (!project) {
    return `<section class="motion-panel">
      <p class="motion-note">This project no longer exists.</p>
      <button type="button" class="ws-btn" data-nova-click="novaWorkspaceBackToProjects">Back to Projects</button>
    </section>`;
  }

  const characters = novaLoadCharacters().filter(
    character => character.projectId === project.id
  );
  const continuity = project.continuity || {
    worldDescription: "",
    visualStyle: "",
    rules: [],
    notes: []
  };
  const confirmingDelete =
    novaWorkspaceDeleteTarget &&
    novaWorkspaceDeleteTarget.type === "project" &&
    novaWorkspaceDeleteTarget.id === project.id;

  let characterCards = "";
  if (!characters.length) {
    characterCards = `<p class="motion-note">No characters yet. Add the first character of this project.</p>`;
  } else {
    characterCards = characters
      .map(character => {
        const appearance = character.appearance || {};
        const traits = [appearance.species, appearance.colors, appearance.distinctiveFeatures]
          .filter(Boolean)
          .join(" · ");
        const confirming =
          novaWorkspaceDeleteTarget &&
          novaWorkspaceDeleteTarget.type === "character" &&
          novaWorkspaceDeleteTarget.id === character.id;
        return `<div class="ws-card">
        <div class="ws-thumb" id="ws-thumb-${character.id}">${character.imageAssetId ? "" : "<span class=\"motion-note\">No reference image</span>"}</div>
        <h3>${novaEscape(character.name)}</h3>
        <p class="ws-text">${novaEscape(character.description || "")}</p>
        ${traits ? `<p class="motion-note">${novaEscape(traits)}</p>` : ""}
        <p class="motion-note">Version ${character.version || 1}</p>
        <div class="ws-row">
          <button type="button" class="ws-btn ws-btn-primary" data-nova-click="novaWorkspaceUseInMotionStudio" data-nova-arg="${project.id}" data-nova-arg2="${character.id}">Use in Motion Studio</button>
          <button type="button" class="ws-btn" data-nova-click="novaWorkspaceEditCharacter" data-nova-arg="${character.id}">Edit</button>
          <button type="button" class="ws-btn ws-btn-danger" data-nova-click="novaWorkspaceAskDeleteCharacter" data-nova-arg="${character.id}">Delete</button>
        </div>
        ${confirming ? novaWorkspaceDeleteConfirmHtml("character", character.id, "Delete this character? This cannot be undone.") : ""}
      </div>`;
      })
      .join("");
  }

  return `<section class="motion-panel">
    <h2>${novaEscape(project.name)}</h2>
    <p class="ws-text">${novaEscape(project.description || "")}</p>
    <div class="ws-row">
      <button type="button" class="ws-btn" data-nova-click="novaWorkspaceBackToProjects">← All Projects</button>
      <button type="button" class="ws-btn" data-nova-click="novaWorkspaceEditProject" data-nova-arg="${project.id}">Edit Project</button>
      <button type="button" class="ws-btn ws-btn-danger" data-nova-click="novaWorkspaceAskDeleteProject" data-nova-arg="${project.id}">Delete Project</button>
    </div>
    ${confirmingDelete ? novaWorkspaceDeleteConfirmHtml("project", project.id, "Delete this project? This cannot be undone.") : ""}
  </section>

  <section class="motion-panel">
    <h2>🎭 Characters</h2>
    <button type="button" class="ws-btn ws-btn-primary" data-nova-click="novaWorkspaceNewCharacter">+ New Character</button>
    <div class="ws-grid">${characterCards}</div>
  </section>

  <section class="motion-panel">
    <h2>🌍 Project Continuity</h2>
    <p class="motion-note">These fields describe the world every character in this project shares. They are frozen into each production job as its continuity snapshot.</p>
    <label class="motion-label" for="wsContinuityWorld">World description</label>
    <textarea class="motion-input" id="wsContinuityWorld" rows="3">${novaEscape(continuity.worldDescription || "")}</textarea>
    <label class="motion-label" for="wsContinuityStyle">Visual style</label>
    ${novaStyleLegacyInputHtml(continuity.visualStyle)}
    <label class="motion-label" for="wsContinuityRules">Continuity rules (one per line)</label>
    <textarea class="motion-input" id="wsContinuityRules" rows="4">${novaEscape((continuity.rules || []).join("\n"))}</textarea>
    <label class="motion-label" for="wsContinuityNotes">Project notes (one per line)</label>
    <textarea class="motion-input" id="wsContinuityNotes" rows="4">${novaEscape((continuity.notes || []).join("\n"))}</textarea>
    <div class="ws-row">
      <button type="button" class="ws-btn ws-btn-primary" data-nova-click="novaWorkspaceSaveContinuity">Save Continuity</button>
    </div>
  </section>

  <section class="motion-panel">
    ${novaWorkspaceObjectsSectionHtml(project)}
  </section>

  <section class="motion-panel">
    ${novaWorkspaceStyleSectionHtml(project)}
  </section>`;
}

function novaWorkspaceCharacterFormHtml() {
  const project = novaGetProject(novaWorkspaceProjectId);
  if (!project) {
    return `<section class="motion-panel">
      <p class="motion-note">This project no longer exists.</p>
      <button type="button" class="ws-btn" data-nova-click="novaWorkspaceBackToProjects">Back to Projects</button>
    </section>`;
  }

  const editing = novaWorkspaceCharacterId
    ? novaGetCharacter(novaWorkspaceCharacterId)
    : null;
  const appearance = (editing && editing.appearance) || {};

  return `<section class="motion-panel">
    <h2>${editing ? "Edit Character" : "New Character"}</h2>
    <p class="motion-note">Project: ${novaEscape(project.name)}</p>
    <label class="motion-label" for="wsCharacterName">Character name</label>
    <input class="motion-input" id="wsCharacterName" type="text" value="${editing ? novaEscape(editing.name) : ""}" placeholder="Example: Cinder">
    <label class="motion-label" for="wsCharacterDescription">Description</label>
    <textarea class="motion-input" id="wsCharacterDescription" rows="3" placeholder="Who is this character?">${editing ? novaEscape(editing.description || "") : ""}</textarea>
    <div class="motion-two">
      <div>
        <label class="motion-label" for="wsCharacterSpecies">Species</label>
        <input class="motion-input" id="wsCharacterSpecies" type="text" value="${novaEscape(appearance.species || "")}" placeholder="Example: Dragon">
      </div>
      <div>
        <label class="motion-label" for="wsCharacterColors">Colours</label>
        <input class="motion-input" id="wsCharacterColors" type="text" value="${novaEscape(appearance.colors || "")}" placeholder="Example: Ash-grey, ember cracks">
      </div>
    </div>
    <label class="motion-label" for="wsCharacterFeatures">Distinctive features</label>
    <input class="motion-input" id="wsCharacterFeatures" type="text" value="${novaEscape(appearance.distinctiveFeatures || "")}" placeholder="Example: Scar on left cheek">
    <label class="motion-label" for="wsCharacterDetails">Permanent details (one per line)</label>
    <textarea class="motion-input" id="wsCharacterDetails" rows="4" placeholder="Details that never change about this character.">${novaEscape(((appearance.permanentDetails) || []).join("\n"))}</textarea>
    <label class="motion-label" for="wsCharacterWardrobe">Wardrobe</label>
    <input class="motion-input" id="wsCharacterWardrobe" type="text" value="${novaEscape(appearance.wardrobe || "")}" placeholder="Example: Grey cloak, leather boots">
    <label class="motion-label" for="wsCharacterHair">Hair</label>
    <input class="motion-input" id="wsCharacterHair" type="text" value="${novaEscape(appearance.hair || "")}" placeholder="Example: Long black braid">
    <label class="motion-label" for="wsCharacterAccessories">Accessories (one per line)</label>
    <textarea class="motion-input" id="wsCharacterAccessories" rows="3" placeholder="Items the character always carries.">${novaEscape(((appearance.accessories) || []).join("\n"))}</textarea>
    <label class="motion-label" for="wsCharacterNotes">Continuity notes (one per line)</label>
    <textarea class="motion-input" id="wsCharacterNotes" rows="4">${novaEscape(((editing && editing.continuityNotes) || []).join("\n"))}</textarea>
    <label class="motion-label">Reference image — stored in this browser.</label>
    <div class="ws-thumb" id="wsCharacterImagePreview">${editing && editing.imageAssetId ? "" : "<span class=\"motion-note\">No reference image saved</span>"}</div>
    <label class="motion-label" for="wsCharacterImage">Identity reference (saved for this character — supplied to the video provider when generation is connected)</label>
    <input class="motion-upload" id="wsCharacterImage" type="file" accept="image/*">
    <p class="motion-note">This image is saved with the character and recorded in production records. It is NOT sent to a video-generation provider yet — face consistency across generated clips is not available in this version.</p>
    <p class="motion-note">Replacing the image only changes this character. Images already recorded in production jobs stay exactly as they were.${editing && editing.imageAssetId ? " Leave empty to keep the current image." : ""}</p>
    <div class="ws-row">
      <button type="button" class="ws-btn ws-btn-primary" data-nova-click="novaWorkspaceSaveCharacter">Save Character</button>
      <button type="button" class="ws-btn" data-nova-click="novaWorkspaceBackToProject">Cancel</button>
    </div>
  </section>`;
}

function novaWorkspaceLoadDetailImages() {
  if (novaWorkspaceView !== "project") return;
  const characters = novaLoadCharacters().filter(
    character => character.projectId === novaWorkspaceProjectId
  );
  characters.forEach(character => {
    if (character.imageAssetId) {
      novaWorkspaceLoadImageInto(
        "ws-thumb-" + character.id,
        character.imageAssetId
      );
    }
  });
}

function novaWorkspaceLoadCharacterFormImage() {
  if (novaWorkspaceView !== "characterForm") return;
  const editing = novaWorkspaceCharacterId
    ? novaGetCharacter(novaWorkspaceCharacterId)
    : null;
  if (editing && editing.imageAssetId) {
    novaWorkspaceLoadImageInto(
      "wsCharacterImagePreview",
      editing.imageAssetId
    );
  }
}

function novaWorkspaceNewProject() {
  novaWorkspaceProjectId = null;
  novaWorkspaceCharacterId = null;
  novaWorkspaceDeleteTarget = null;
  novaWorkspaceView = "projectForm";
  novaWorkspaceSetStatus("");
  novaRenderWorkspace();
}

function novaWorkspaceEditProject(projectId) {
  novaWorkspaceProjectId = projectId;
  novaWorkspaceCharacterId = null;
  novaWorkspaceDeleteTarget = null;
  novaWorkspaceView = "projectForm";
  novaWorkspaceSetStatus("");
  novaRenderWorkspace();
}

function novaWorkspaceSaveProject() {
  const name = document.getElementById("wsProjectName").value.trim();
  const description = document
    .getElementById("wsProjectDescription")
    .value.trim();

  if (!name) {
    novaWorkspaceSetStatus("Give the project a name before saving.");
    return;
  }

  if (novaWorkspaceProjectId) {
    const saved = novaUpdateProject(novaWorkspaceProjectId, {
      name,
      description
    });
    if (!saved) {
      novaWorkspaceSetStatus("That project could not be saved.");
      return;
    }
    novaWorkspaceSetStatus("Project saved.");
  } else {
    const pickedStyle = novaReadStylePicker("wsNewStyle");
    const styleSelect = document.getElementById("wsNewStylePreset");
    if (styleSelect && styleSelect.value === "custom" && !pickedStyle) {
      novaWorkspaceSetStatus("Enter a custom direction for the Custom style.");
      return;
    }
    const created = novaCreateProject(name, description, pickedStyle);
    if (!created) {
      novaWorkspaceSetStatus("That project could not be created.");
      return;
    }
    novaWorkspaceProjectId = created.id;
    novaWorkspaceSetStatus("Project created.");
  }

  novaWorkspaceView = "project";
  novaRenderWorkspace();
}

function novaWorkspaceOpenProject(projectId) {
  novaWorkspaceProjectId = projectId;
  novaWorkspaceCharacterId = null;
  novaWorkspaceDeleteTarget = null;
  novaWorkspaceView = "project";
  novaWorkspaceSetStatus("");
  novaRenderWorkspace();
}

function novaWorkspaceBackToProjects() {
  novaWorkspaceProjectId = null;
  novaWorkspaceCharacterId = null;
  novaWorkspaceDeleteTarget = null;
  novaWorkspaceView = "projects";
  novaWorkspaceSetStatus("");
  novaRenderWorkspace();
}

function novaWorkspaceBackToProject() {
  novaWorkspaceCharacterId = null;
  novaWorkspaceDeleteTarget = null;
  novaWorkspaceView = "project";
  novaWorkspaceSetStatus("");
  novaRenderWorkspace();
}

function novaWorkspaceToggleArchived() {
  novaWorkspaceShowArchived = !novaWorkspaceShowArchived;
  novaRenderWorkspace();
}

function novaWorkspaceArchiveProject(projectId) {
  const archived = novaUpdateProject(projectId, { archived: true });
  if (!archived) {
    novaWorkspaceSetStatus("That project could not be archived.");
    return;
  }
  if (novaSelectedProjectId === projectId) {
    novaSelectedProjectId = null;
    novaSelectedCharacterId = null;
  }
  novaWorkspaceSetStatus(
    "Project archived. It is hidden from Motion Studio."
  );
  novaRenderWorkspace();
}

function novaWorkspaceUnarchiveProject(projectId) {
  const restored = novaUpdateProject(projectId, { archived: false });
  if (!restored) {
    novaWorkspaceSetStatus("That project could not be restored.");
    return;
  }
  novaWorkspaceSetStatus("Project restored.");
  novaRenderWorkspace();
}

function novaWorkspaceAskDeleteProject(projectId) {
  const jobs = novaWorkspaceJobsForProject(projectId);
  if (jobs.length) {
    novaWorkspaceSetStatus(
      "This project cannot be deleted: it is used by " +
        jobs.length +
        " production job" +
        (jobs.length === 1 ? "" : "s") +
        ". Production history is never destroyed."
    );
    return;
  }

  const characters = novaLoadCharacters().filter(
    character => character.projectId === projectId
  );
  if (characters.length) {
    novaWorkspaceSetStatus(
      "Delete this project\u2019s " +
        characters.length +
        " character" +
        (characters.length === 1 ? "" : "s") +
        " first. Projects are never deleted with characters inside them."
    );
    return;
  }

  novaWorkspaceDeleteTarget = { type: "project", id: projectId };
  novaWorkspaceSetStatus("");
  novaRenderWorkspace();
}

function novaWorkspaceConfirmDeleteProject(projectId) {
  const jobs = novaWorkspaceJobsForProject(projectId);
  const characters = novaLoadCharacters().filter(
    character => character.projectId === projectId
  );
  if (jobs.length || characters.length) {
    novaWorkspaceDeleteTarget = null;
    novaWorkspaceSetStatus("This project can no longer be deleted.");
    novaRenderWorkspace();
    return;
  }

  const saved = novaSaveProjects(
    novaLoadProjects().filter(project => project.id !== projectId)
  );

  if (!saved) {
    novaWorkspaceSetStatus("Project deletion failed. Your project was preserved.");
    novaRenderWorkspace();
    return;
  }

  if (novaSelectedProjectId === projectId) {
    novaSelectedProjectId = null;
    novaSelectedCharacterId = null;
  }

  novaWorkspaceDeleteTarget = null;
  novaWorkspaceProjectId = null;
  novaWorkspaceCharacterId = null;
  novaWorkspaceView = "projects";
  novaWorkspaceSetStatus("Project deleted.");
  novaRenderWorkspace();
}

function novaWorkspaceCancelDelete() {
  novaWorkspaceDeleteTarget = null;
  novaWorkspaceSetStatus("");
  novaRenderWorkspace();
}

function novaWorkspaceNewCharacter() {
  if (!novaGetProject(novaWorkspaceProjectId)) {
    novaWorkspaceSetStatus("Select a project first.");
    return;
  }
  novaWorkspaceCharacterId = null;
  novaWorkspaceDeleteTarget = null;
  novaWorkspaceView = "characterForm";
  novaWorkspaceSetStatus("");
  novaRenderWorkspace();
}

function novaWorkspaceEditCharacter(characterId) {
  const character = novaGetCharacter(characterId);
  if (!character) {
    novaWorkspaceSetStatus("That character no longer exists.");
    return;
  }
  novaWorkspaceProjectId = character.projectId;
  novaWorkspaceCharacterId = characterId;
  novaWorkspaceDeleteTarget = null;
  novaWorkspaceView = "characterForm";
  novaWorkspaceSetStatus("");
  novaRenderWorkspace();
}

async function novaWorkspaceSaveCharacter() {
  const name = document.getElementById("wsCharacterName").value.trim();
  const description = document
    .getElementById("wsCharacterDescription")
    .value.trim();
  const species = document.getElementById("wsCharacterSpecies").value.trim();
  const colors = document.getElementById("wsCharacterColors").value.trim();
  const distinctiveFeatures = document
    .getElementById("wsCharacterFeatures")
    .value.trim();
  const permanentDetails = novaWorkspaceLines(
    document.getElementById("wsCharacterDetails").value
  );
  const wardrobe = document.getElementById("wsCharacterWardrobe").value.trim();
  const hair = document.getElementById("wsCharacterHair").value.trim();
  const accessories = novaWorkspaceLines(
    document.getElementById("wsCharacterAccessories").value
  );
  const continuityNotes = novaWorkspaceLines(
    document.getElementById("wsCharacterNotes").value
  );

  if (!name) {
    novaWorkspaceSetStatus("Give the character a name before saving.");
    return;
  }

  const editing = novaWorkspaceCharacterId
    ? novaGetCharacter(novaWorkspaceCharacterId)
    : null;
  const projectId = editing
    ? editing.projectId
    : novaWorkspaceProjectId;

  if (!novaGetProject(projectId)) {
    novaWorkspaceSetStatus("Select a project first.");
    return;
  }

  let imageAssetId = editing ? editing.imageAssetId || null : null;
  const fileInput = document.getElementById("wsCharacterImage");
  const file =
    fileInput && fileInput.files.length ? fileInput.files[0] : null;

  if (file) {
    if (file.size > 5 * 1024 * 1024) {
      novaWorkspaceSetStatus(
        "Reference images must be 5 MB or smaller."
      );
      return;
    }
    const uploaded = await novaStoreImage(file);
    if (!uploaded || !uploaded.id) {
      novaWorkspaceSetStatus(
        "NOVA could not save the uploaded reference image. Please check browser storage."
      );
      return;
    }
    imageAssetId = uploaded.id;
  }

  const appearance = {
    species,
    colors,
    distinctiveFeatures,
    permanentDetails,
    wardrobe,
    hair,
    accessories
  };

  if (editing) {
    const saved = novaUpdateCharacter(editing.id, {
      name,
      description,
      appearance,
      imageAssetId,
      continuityNotes
    });
    if (!saved) {
      novaWorkspaceSetStatus("That character could not be saved.");
      return;
    }
    novaWorkspaceSetStatus("Character saved.");
  } else {
    const created = novaCreateCharacter(projectId, {
      name,
      description,
      appearance,
      imageAssetId,
      continuityNotes
    });
    if (!created) {
      novaWorkspaceSetStatus("That character could not be created.");
      return;
    }
    novaWorkspaceCharacterId = created.id;
    novaWorkspaceSetStatus("Character created.");
  }

  novaWorkspaceView = "project";
  novaRenderWorkspace();
}

function novaWorkspaceAskDeleteCharacter(characterId) {
  const jobs = novaWorkspaceJobsForCharacter(characterId);
  if (jobs.length) {
    novaWorkspaceSetStatus(
      "This character cannot be deleted: it is used by " +
        jobs.length +
        " production job" +
        (jobs.length === 1 ? "" : "s") +
        ". Production history is never destroyed."
    );
    return;
  }

  novaWorkspaceDeleteTarget = { type: "character", id: characterId };
  novaWorkspaceSetStatus("");
  novaRenderWorkspace();
}

function novaWorkspaceConfirmDeleteCharacter(characterId) {
  const jobs = novaWorkspaceJobsForCharacter(characterId);
  if (jobs.length) {
    novaWorkspaceDeleteTarget = null;
    novaWorkspaceSetStatus("This character can no longer be deleted.");
    novaRenderWorkspace();
    return;
  }

  const character = novaGetCharacter(characterId);
  if (!character) {
    novaWorkspaceSetStatus(
      "This character no longer exists. Refresh the workspace before continuing."
    );
    novaRenderWorkspace();
    return;
  }

  // Inconsistent-data safeguard: never delete one side of a broken
  // character/project relationship. If the character's project is
  // missing, the project's character mirror is not a list, or the
  // mirror does not contain this character, block the deletion
  // before anything is written and say the relationship needs repair.
  const project = novaGetProject(character.projectId);
  if (!project) {
    novaWorkspaceSetStatus(
      "This character's project could not be found. Deletion is blocked until the character's project relationship is repaired."
    );
    novaRenderWorkspace();
    return;
  }
  if (!Array.isArray(project.characterIds)) {
    novaWorkspaceSetStatus(
      "This character's project record is damaged. Deletion is blocked until the character's project relationship is repaired."
    );
    novaRenderWorkspace();
    return;
  }
  if (!project.characterIds.includes(characterId)) {
    novaWorkspaceSetStatus(
      "This character is missing from its project's character list. Repair the relationship before deleting."
    );
    novaRenderWorkspace();
    return;
  }

  const originalCharacters = novaLoadCharacters();
  const saved = novaSaveCharacters(
    originalCharacters.filter(item => item.id !== characterId)
  );

  if (!saved) {
    novaWorkspaceSetStatus("Character deletion failed. Your character was preserved.");
    novaRenderWorkspace();
    return;
  }

  const updated = novaUpdateProject(project.id, {
    characterIds: project.characterIds.filter(id => id !== characterId)
  });
  if (!updated) {
    const restored = novaSaveCharacters(originalCharacters);
    novaWorkspaceSetStatus(
      restored
        ? "Character deletion failed. Your character was preserved."
        : "Character deletion failed and the character could not be restored. Please check browser storage."
    );
    novaRenderWorkspace();
    return;
  }

  if (novaSelectedCharacterId === characterId) {
    novaSelectedCharacterId = null;
  }

  novaWorkspaceDeleteTarget = null;
  novaWorkspaceCharacterId = null;
  novaWorkspaceView = "project";
  novaWorkspaceSetStatus("Character deleted.");
  novaRenderWorkspace();
}

function novaWorkspaceSaveContinuity() {
  const project = novaGetProject(novaWorkspaceProjectId);
  if (!project) {
    novaWorkspaceSetStatus("That project no longer exists.");
    return;
  }

  // Stage 3.5A: an empty style input keeps a structured
  // preset style (the legacy input is read-only for preset
  // styles); a typed value replaces it with a free-text
  // style.
  const styleInput = document.getElementById("wsContinuityStyle").value.trim();
  const storedStyle = project.continuity ? project.continuity.visualStyle : "";
  const continuity = {
    worldDescription: document
      .getElementById("wsContinuityWorld")
      .value.trim(),
    visualStyle:
      styleInput === "" &&
      storedStyle &&
      typeof storedStyle === "object"
        ? storedStyle
        : styleInput,
    rules: novaWorkspaceLines(
      document.getElementById("wsContinuityRules").value
    ),
    notes: novaWorkspaceLines(
      document.getElementById("wsContinuityNotes").value
    ),
    // Stage 3.5B: the objects + locations lists live on
    // the continuity object but have their own section —
    // carry the stored lists forward, or this save would
    // wipe them.
    objects: novaGetProjectObjects(project),
    locations: novaGetProjectLocations(project)
  };

  const saved = novaUpdateProject(project.id, { continuity });
  if (!saved) {
    novaWorkspaceSetStatus("Continuity could not be saved.");
    return;
  }

  novaWorkspaceSetStatus("Continuity saved.");
  novaRenderWorkspace();
}

function novaWorkspaceUseInMotionStudio(projectId, characterId) {
  const project = novaGetProject(projectId);
  const character = novaGetCharacter(characterId);
  if (
    !project ||
    project.archived ||
    !character ||
    character.projectId !== projectId
  ) {
    novaWorkspaceSetStatus(
      "That character is not available for production."
    );
    return;
  }
  novaSelectedProjectId = projectId;
  novaSelectedCharacterId = characterId;
  closeProjectWorkspace();
  openMotionStudio();
}

/* ---------- Motion Studio production identity ---------- */

function novaRenderProductionIdentity() {
  const projectSelect = document.getElementById("motionProject");
  const characterSelect = document.getElementById("motionCharacterSelect");
  const review = document.getElementById("motionIdentityReview");
  if (!projectSelect || !characterSelect || !review) return;

  // Self-healing: drop a selection whose project or character is gone,
  // archived, or no longer belongs to the selected project.
  const project = novaSelectedProjectId
    ? novaGetProject(novaSelectedProjectId)
    : null;
  if (novaSelectedProjectId && (!project || project.archived)) {
    novaSelectedProjectId = null;
    novaSelectedCharacterId = null;
  }
  const character = novaSelectedCharacterId
    ? novaGetCharacter(novaSelectedCharacterId)
    : null;
  if (
    novaSelectedCharacterId &&
    (!character || character.projectId !== novaSelectedProjectId)
  ) {
    novaSelectedCharacterId = null;
  }

  const projects = novaLoadProjects().filter(item => !item.archived);
  projectSelect.innerHTML =
    `<option value="">Standalone Production</option>` +
    projects
      .map(
        item =>
          `<option value="${item.id}"${item.id === novaSelectedProjectId ? " selected" : ""}>${novaEscape(item.name)}</option>`
      )
      .join("");

  if (!novaSelectedProjectId) {
    characterSelect.innerHTML = `<option value="">No character</option>`;
    characterSelect.disabled = true;
    review.innerHTML = `<p class="motion-note">Standalone production: no project identity. Your video uses the description and reference image you provide here.</p>`;
    return;
  }

  const characters = novaLoadCharacters().filter(
    item => item.projectId === novaSelectedProjectId
  );
  characterSelect.disabled = false;
  characterSelect.innerHTML =
    `<option value="">Select a character</option>` +
    characters
      .map(
        item =>
          `<option value="${item.id}"${item.id === novaSelectedCharacterId ? " selected" : ""}>${novaEscape(item.name)}</option>`
      )
      .join("");

  const selected = novaSelectedCharacterId
    ? novaGetCharacter(novaSelectedCharacterId)
    : null;
  if (!selected) {
    review.innerHTML = `<p class="motion-note">Select a character to use this project\u2019s saved identity for your production.</p>`;
    // Stage 3.5B: the production continuity section
    // (Section 16.3) — a project plan without a selected
    // character still carries warnings and decisions.
    if (novaMotionPlan && novaMotionPlan.projectId === novaSelectedProjectId) {
      review.innerHTML += novaProductionContinuityReviewHtml(project, novaMotionPlan);
    }
    return;
  }

  const appearance = selected.appearance || {};
  const traits = [appearance.species, appearance.colors, appearance.distinctiveFeatures]
    .filter(Boolean)
    .join(" \u00b7 ");
  review.innerHTML = `<div class="ws-identity">
    <div class="ws-thumb ws-thumb-small" id="motionIdentityThumb">${selected.imageAssetId ? "" : "<span class=\"motion-note\">No reference image</span>"}</div>
    <div>
      <strong>${novaEscape(selected.name)}</strong><br>
      <span class="motion-note">${novaEscape(selected.description || "")}</span><br>
      ${traits ? `<span class="motion-note">${novaEscape(traits)}</span><br>` : ""}
      <span class="motion-note">Version ${selected.version || 1}</span>
    </div>
  </div>` + novaContinuityReviewHtml(selected, project);
  // Stage 3.5A: the reference-image statement (Section 6)
  // and the Visual Style section (preset, overrides,
  // warnings).
  review.innerHTML += `<p class="motion-note">${novaEscape(NOVA_REFERENCE_IMAGE_STRINGS.reviewStatement)}</p>`;
  review.innerHTML += novaProductionStyleSectionHtml(selected, project);
  // Stage 3.5B: the production continuity section (Section 16.3).
  if (novaMotionPlan && novaMotionPlan.projectId === novaSelectedProjectId) {
    review.innerHTML += novaProductionContinuityReviewHtml(project, novaMotionPlan);
  }
  if (selected.imageAssetId) {
    novaWorkspaceLoadImageInto("motionIdentityThumb", selected.imageAssetId);
  }
}

function novaSelectProductionProject(projectId) {
  if (!projectId) {
    novaSelectedProjectId = null;
    novaSelectedCharacterId = null;
  } else {
    novaSelectedProjectId = projectId;
    novaSelectedCharacterId = null;
  }
  novaRenderProductionIdentity();
}

function novaSelectProductionCharacter(characterId) {
  novaSelectedCharacterId = characterId || null;
  novaRenderProductionIdentity();
}

/* =====================================================================
   NOVA MOTION — Stage 3.4E: Continuity Intelligence
   ---------------------------------------------------------------------
   Project + character memory becomes active planning input instead of
   inert storage. All helpers here are read-only: nothing in this
   section writes a project, character, or job record.

   - novaBuildContinuityContext(projectId, characterId) gathers the
     saved project + character memory into one structured, deep-copied
     context, or returns a clear error when the relationship is
     invalid.
   - novaCheckContinuityConflicts(context, promptText) compares the
     user's prompt against the saved memory with deterministic
     keyword/phrase rules and returns warnings. It is NOT AI
     reasoning and never claims to be; warnings are for the user to
     review and never block generation.
   - novaContinuitySceneLine(context) builds one additive sentence
     for the generated scene prompts. The user's original prompt
     text is never modified.
   - novaDismissContinuityWarning(key) hides one warning for the
     current session only; a reload shows warnings again.

   Integration points (see 34e-design.md):
   - buildMotionPlan() adds the scene line + refreshes the review.
   - novaCreateProjectJob() snapshots a fresh context at creation.
   - novaRenderProductionIdentity() shows the continuity summary
     and warnings via novaContinuityReviewHtml().
   ===================================================================== */

// Dismissed warning keys, current session only. A reload starts
// with an empty set, so a dismissed warning never hides a conflict
// from a future session silently.
let novaDismissedContinuityWarnings = new Set();

// Fixed lexicons for the deterministic conflict checks. Deliberately
// small: these are era/feature words, not a language model.
const NOVA_CONTINUITY_COLORS = [
  "black", "white", "red", "blue", "green", "yellow", "orange",
  "purple", "pink", "brown", "grey", "gray", "silver", "gold",
  "golden", "bronze", "copper", "crimson", "azure", "emerald",
  "scarlet", "violet", "amber", "ivory", "obsidian", "blonde"
];

const NOVA_CONTINUITY_FEATURES = [
  "scales", "scale", "eyes", "eye", "eyed", "hair", "skin", "fur",
  "wings", "wing", "horns", "horn", "claws", "claw", "teeth",
  "tooth", "feathers", "feather", "tail", "armor", "armour",
  "cloak", "robe", "dress", "crown", "beard", "ears", "ear",
  "nose", "face", "hands", "hand"
];

const NOVA_CONTINUITY_NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5
};

// Era markers are era-denoting words only. Genre words (dragon,
// magic, village, forest) are deliberately excluded: a dragon can
// appear in any era, but a castle or a skyscraper places one.
const NOVA_CONTINUITY_MEDIEVAL_MARKERS = [
  "medieval", "castle", "knight", "sword", "throne", "kingdom",
  "dungeon", "drawbridge", "moat", "blacksmith", "peasant"
];

const NOVA_CONTINUITY_MODERN_MARKERS = [
  "modern", "skyscraper", "smartphone", "computer", "airplane",
  "aeroplane", "subway", "neon", "laptop", "internet", "car", "phone"
];

function novaContinuityText(value) {
  return typeof value === "string" ? value : "";
}

function novaContinuityList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => typeof item === "string");
}

function novaContinuityTokens(text) {
  if (typeof text !== "string") return [];
  const found = text.toLowerCase().match(/[a-z0-9]+/g);
  return found || [];
}

function novaBuildContinuityContext(projectId, characterId) {
  const project = novaGetProject(projectId);

  if (!project) {
    return { context: null, error: "The selected project does not exist." };
  }

  const character = novaGetCharacter(characterId);

  if (!character) {
    return { context: null, error: "The selected character does not exist." };
  }

  // Belonging is decided by the character's own projectId, the same
  // rule as 3.4C. The characterIds mirror is never consulted here.
  if (character.projectId !== project.id) {
    return {
      context: null,
      error: "The selected character does not belong to the selected project."
    };
  }

  // Malformed records coerce to safe defaults; the builder never
  // throws on stored data.
  const continuity =
    project.continuity &&
    typeof project.continuity === "object" &&
    !Array.isArray(project.continuity)
      ? project.continuity
      : {};
  const appearance =
    character.appearance &&
    typeof character.appearance === "object" &&
    !Array.isArray(character.appearance)
      ? character.appearance
      : {};

  return {
    context: {
      project: {
        id: project.id,
        name: novaContinuityText(project.name),
        description: novaContinuityText(project.description),
        worldDescription: novaContinuityText(continuity.worldDescription),
        visualStyle: novaContinuityText(continuity.visualStyle),
        rules: novaContinuityList(continuity.rules),
        notes: novaContinuityList(continuity.notes)
      },
      character: {
        id: character.id,
        name: novaContinuityText(character.name),
        description: novaContinuityText(character.description),
        species: novaContinuityText(appearance.species),
        colors: novaContinuityText(appearance.colors),
        distinctiveFeatures: novaContinuityText(appearance.distinctiveFeatures),
        permanentDetails: novaContinuityList(appearance.permanentDetails),
        continuityNotes: novaContinuityList(character.continuityNotes),
        imageAssetId: character.imageAssetId || null,
        version:
          typeof character.version === "number" && character.version > 0
            ? character.version
            : 1
      },
      builtAt: new Date().toISOString()
    },
    error: null
  };
}

// Maps a feature token to its canonical (singular) form so "scales"
// in the prompt matches "scale" in a saved detail.
function novaContinuityFeatureKey(token, features) {
  if (token.endsWith("s") && features.has(token.slice(0, -1))) {
    return token.slice(0, -1);
  }
  return token;
}

// True when the token names a feature (a lexicon word, the species
// word, or the plural of one of those).
function novaContinuityIsFeature(token, features) {
  if (features.has(token)) return true;
  return token.endsWith("s") && features.has(token.slice(0, -1));
}

// True when a stretch of text contains at least one feature token.
// Used by the guarded splitter: a boundary only separates two
// descriptions when both sides describe a feature.
function novaContinuityHasFeature(text, features) {
  return novaContinuityTokens(text).some(token =>
    novaContinuityIsFeature(token, features)
  );
}

// Splits text at boundaries matched by `pattern`, but only where
// BOTH sides contain a feature. A boundary inside one description
// (a colour list such as "red, black and silver scales", or "black
// and silver scales") is left alone, so no colour is orphaned.
// The split recurses on both halves, so every qualifying boundary
// is honoured. `pattern` must be non-global (exec always restarts
// from the beginning of the text it is given).
function novaContinuitySplitGuarded(text, pattern, features) {
  const match = pattern.exec(text);
  if (!match) return [text];
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  if (
    novaContinuityHasFeature(before, features) &&
    novaContinuityHasFeature(after, features)
  ) {
    return novaContinuitySplitGuarded(before, pattern, features).concat(
      novaContinuitySplitGuarded(after, pattern, features)
    );
  }
  // This boundary does not qualify; try the next one. The text up
  // to and including this boundary is prepended to the first piece
  // of the recursion, so nothing is lost.
  const rest = novaContinuitySplitGuarded(after, pattern, features);
  rest[0] = text.slice(0, match.index + match[0].length) + rest[0];
  return rest;
}

// Returns a Map: canonical feature -> Set of colors attached to that
// feature in the text.
//
// CORRECTION 2 — punctuation-aware, feature-aware matching. The old
// fixed token window dropped punctuation entirely, so in a comma
// list a colour could attach to the wrong feature ("blue" in "red
// scales, blue eyes" attached to scales) or mask a real
// contradiction ("blue" in saved "red scales, blue eyes" attached
// to scales, hiding blue-vs-red). Matching now works in two steps:
//
// 1. SEGMENT: split the text at punctuation and conjunctions, but
//    only where both sides describe a feature — so "red scales,
//    blue eyes" splits into two descriptions, while "black and
//    silver scales" and "red, black and silver scales" stay whole
//    (a colour list, not two descriptions).
// 2. ASSIGN: within a segment, each colour attaches to the NEAREST
//    feature (max 4 tokens away, so "black and silver scales",
//    "scales of red" and "eyes of deep blue" all match). On a tie
//    the colour goes to the FOLLOWING feature — adjectives precede
//    nouns in English ("blue" in "red scales blue eyes" belongs
//    to eyes). A colour with no feature nearby is left unassigned;
//    on the saved side the bare-colour fallback still attaches
//    feature-less statements to the species.
function novaContinuityFeatureColors(text, extraFeatures) {
  const features = new Set(NOVA_CONTINUITY_FEATURES.concat(extraFeatures || []));
  const colors = new Set(NOVA_CONTINUITY_COLORS);
  const found = new Map();

  // Punctuation boundaries first (sentence/clause breaks are the
  // strongest separators), then conjunctions within each part.
  const segments = novaContinuitySplitGuarded(text, /[,;:.!?\n]/, features)
    .map(part =>
      novaContinuitySplitGuarded(part, /\b(?:and|but|or)\b/i, features)
    )
    .reduce((all, parts) => all.concat(parts), []);

  segments.forEach(segment => {
    const tokens = novaContinuityTokens(segment);
    const featureAt = [];
    const colorAt = [];
    tokens.forEach((token, i) => {
      if (novaContinuityIsFeature(token, features)) {
        featureAt.push({
          index: i,
          key: novaContinuityFeatureKey(token, features)
        });
      } else if (colors.has(token)) {
        colorAt.push({ index: i, value: token });
      }
    });
    colorAt.forEach(color => {
      let best = null;
      let bestDistance = Infinity;
      featureAt.forEach(feature => {
        const distance = Math.abs(feature.index - color.index);
        if (
          distance <= 4 &&
          (distance < bestDistance ||
            (distance === bestDistance && feature.index > best.index))
        ) {
          best = feature;
          bestDistance = distance;
        }
      });
      if (best) {
        if (!found.has(best.key)) found.set(best.key, new Set());
        found.get(best.key).add(color.value);
      }
    });
  });

  return found;
}

// Finds a count (number word or digit) near eye/eyes/eyed, or null.
function novaContinuityEyeCount(text) {
  const tokens = novaContinuityTokens(text);

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "eye" && tokens[i] !== "eyes" && tokens[i] !== "eyed") {
      continue;
    }
    for (let j = Math.max(0, i - 2); j <= Math.min(tokens.length - 1, i + 2); j++) {
      if (j === i) continue;
      if (
        Object.prototype.hasOwnProperty.call(
          NOVA_CONTINUITY_NUMBER_WORDS,
          tokens[j]
        )
      ) {
        return NOVA_CONTINUITY_NUMBER_WORDS[tokens[j]];
      }
      if (/^[1-5]$/.test(tokens[j])) return Number(tokens[j]);
    }
  }

  return null;
}

function novaContinuityEra(text) {
  const tokens = new Set(novaContinuityTokens(text));
  const medieval = NOVA_CONTINUITY_MEDIEVAL_MARKERS.some(marker =>
    tokens.has(marker)
  );
  const modern = NOVA_CONTINUITY_MODERN_MARKERS.some(marker =>
    tokens.has(marker)
  );
  if (medieval && !modern) return "medieval";
  if (modern && !medieval) return "modern";
  return null;
}

function novaCheckContinuityConflicts(context, promptText) {
  const warnings = [];

  if (!context || !context.character || !context.project) return warnings;

  const prompt = typeof promptText === "string" ? promptText : "";
  if (!prompt.trim()) return warnings;

  // The character's own kind (last species word, e.g. "dragon" in
  // "fire dragon") counts as a feature, so a colors statement like
  // "black and silver" can be compared against "red dragon".
  const speciesTokens = novaContinuityTokens(context.character.species || "");
  const speciesFeature = speciesTokens.length
    ? speciesTokens[speciesTokens.length - 1]
    : null;
  const extraFeatures = speciesFeature ? [speciesFeature] : [];

  // --- 1. Color vs feature ---
  const promptColors = novaContinuityFeatureColors(prompt, extraFeatures);
  const savedStatements = context.character.permanentDetails.concat(
    context.character.colors ? [context.character.colors] : []
  );
  const savedColors = new Map();

  savedStatements.forEach(statement => {
    const found = novaContinuityFeatureColors(statement, extraFeatures);
    let anyFeature = false;
    found.forEach((colors, feature) => {
      anyFeature = true;
      if (!savedColors.has(feature)) savedColors.set(feature, new Set());
      colors.forEach(color => savedColors.get(feature).add(color));
    });
    // Colors with no feature noun attach to the species.
    if (!anyFeature && speciesFeature) {
      const bare = novaContinuityTokens(statement).filter(token =>
        NOVA_CONTINUITY_COLORS.includes(token)
      );
      if (bare.length) {
        if (!savedColors.has(speciesFeature)) {
          savedColors.set(speciesFeature, new Set());
        }
        bare.forEach(color => savedColors.get(speciesFeature).add(color));
      }
    }
  });

  const seen = new Set();
  promptColors.forEach((promptSet, feature) => {
    if (!savedColors.has(feature)) return;
    const savedSet = savedColors.get(feature);
    promptSet.forEach(promptColor => {
      if (savedSet.has(promptColor)) return;
      savedSet.forEach(savedColor => {
        const key = "color:" + feature + ":" + savedColor + ":" + promptColor;
        if (seen.has(key)) return;
        seen.add(key);
        warnings.push({
          key,
          kind: "appearance",
          message:
            "Prompt describes the " +
            feature +
            " as " +
            promptColor +
            ", but the saved permanent details say " +
            savedColor +
            "."
        });
      });
    });
  });

  // --- 2. Eye count ---
  const promptEyes = novaContinuityEyeCount(prompt);
  let savedEyes = null;
  for (const statement of context.character.permanentDetails) {
    savedEyes = novaContinuityEyeCount(statement);
    if (savedEyes !== null) break;
  }
  if (promptEyes !== null && savedEyes !== null && promptEyes !== savedEyes) {
    warnings.push({
      key: "eyes:" + savedEyes + ":" + promptEyes,
      kind: "count",
      message:
        "Prompt describes " +
        promptEyes +
        (promptEyes === 1 ? " eye" : " eyes") +
        ", but the saved permanent details say " +
        savedEyes +
        (savedEyes === 1 ? " eye" : " eyes") +
        "."
    });
  }

  // --- 3. Era / setting ---
  const projectEra = novaContinuityEra(
    (context.project.worldDescription || "") +
      " " +
      (context.project.visualStyle || "")
  );
  const promptEra = novaContinuityEra(prompt);
  if (projectEra && promptEra && projectEra !== promptEra) {
    warnings.push({
      key: "era:" + projectEra + ":" + promptEra,
      kind: "setting",
      message:
        "The project world is " +
        projectEra +
        ", but this prompt reads as " +
        promptEra +
        ". Check the setting matches the world you established."
    });
  }

  // Stage 3.5A: wardrobe / hair / accessories checks (the
  // same matcher, more input). The `seen` set guards
  // against double-reporting a key the base checks already
  // raised.
  const appearanceWarnings = novaCheckAppearanceConflicts(
    context,
    prompt,
    seen
  );
  appearanceWarnings.forEach(warning => {
    if (seen.has(warning.key)) return;
    seen.add(warning.key);
    warnings.push(warning);
  });

  return warnings;
}

function novaContinuitySceneLine(context) {
  if (!context || !context.character || !context.project) return "";

  // Every memory category the context retrieves reaches the scene
  // prompt, each under a clear label so the model can tell permanent
  // character traits apart from project-world rules and general
  // notes. Only non-empty values are included, and no category is
  // repeated. The project's visual style is labelled "Project visual
  // style" so it cannot be confused with the scene's own
  // "Visual style" line (the selected plan style).
  const parts = [];
  const project = context.project;
  const character = context.character;

  if (project.name) {
    parts.push(
      "Project: " +
        project.name +
        (project.description ? " — " + project.description : "")
    );
  } else if (project.description) {
    parts.push("Project: " + project.description);
  }
  if (project.worldDescription) {
    parts.push("World: " + project.worldDescription);
  }
  if (project.visualStyle) {
    parts.push("Project visual style: " + project.visualStyle);
  }
  if (project.rules.length) {
    parts.push("Project rules: " + project.rules.join("; "));
  }
  if (project.notes.length) {
    parts.push("Project notes: " + project.notes.join("; "));
  }

  if (character.name) {
    parts.push(
      "Character: " +
        character.name +
        " (version " +
        (character.version || 1) +
        ")" +
        (character.description ? " — " + character.description : "")
    );
  } else if (character.description) {
    parts.push("Character: " + character.description);
  }
  if (character.species) {
    parts.push("Species: " + character.species);
  }
  if (character.colors) {
    parts.push("Colors: " + character.colors);
  }
  if (character.distinctiveFeatures) {
    parts.push("Distinctive features: " + character.distinctiveFeatures);
  }
  if (character.permanentDetails.length) {
    parts.push(
      "Permanent details: " + character.permanentDetails.join("; ")
    );
  }
  // Stage 3.5A: wardrobe / hair / accessories (only when
  // non-empty; the context carries them after enrichment).
  if (character.wardrobe) {
    parts.push("Wardrobe: " + character.wardrobe);
  }
  if (character.hair) {
    parts.push("Hair: " + character.hair);
  }
  if (character.accessories && character.accessories.length) {
    parts.push("Accessories: " + character.accessories.join("; "));
  }
  if (character.continuityNotes.length) {
    parts.push("Character notes: " + character.continuityNotes.join("; "));
  }

  if (!parts.length) return "";
  return "Saved continuity: " + parts.join(". ") + ".";
}

function novaDismissContinuityWarning(key) {
  novaDismissedContinuityWarnings.add(key);
  novaRenderProductionIdentity();
}

// Builds the continuity summary + warnings HTML appended to the
// Production Identity card. Warning keys contain only [a-z0-9:],
// so they are safe inside the single-quoted onclick argument.
function novaContinuityReviewHtml(character, project) {
  const built = novaBuildContinuityContext(project.id, character.id);

  if (!built || !built.context) {
    return (
      `<div class="ws-continuity"><p class="motion-note">` +
      novaEscape(
        built && built.error
          ? built.error
          : "Continuity information is unavailable."
      ) +
      `</p></div>`
    );
  }

  const context = built.context;
  // Stage 3.5A: attach wardrobe / hair / accessories so
  // the appearance checks (Section 5.2) run in this review.
  novaAttachAppearanceToContext(context, character);
  const promptField = document.getElementById("motionPrompt");
  const promptText = promptField ? promptField.value : "";
  const warnings = novaCheckContinuityConflicts(context, promptText).filter(
    warning => !novaDismissedContinuityWarnings.has(warning.key)
  );

  let html = `<div class="ws-continuity">`;
  html += `<p><strong>Continuity review — ${novaEscape(context.project.name)}</strong></p>`;
  html += `<p class="motion-note">Character version ${context.character.version}</p>`;

  if (context.project.description) {
    html += `<p class="motion-note">Project description: ${novaEscape(context.project.description)}</p>`;
  } else {
    html += `<p class="motion-note">No project description saved yet.</p>`;
  }
  if (context.project.worldDescription) {
    html += `<p class="motion-note">World: ${novaEscape(context.project.worldDescription)}</p>`;
  }
  if (context.project.visualStyle) {
    html += `<p class="motion-note">Visual style: ${novaEscape(context.project.visualStyle)}</p>`;
  } else {
    html += `<p class="motion-note">No visual style saved for this project yet.</p>`;
  }

  if (context.character.permanentDetails.length) {
    html +=
      `<p class="motion-note">Permanent details:</p><ul class="ws-summary-list">` +
      context.character.permanentDetails
        .map(detail => `<li>${novaEscape(detail)}</li>`)
        .join("") +
      `</ul>`;
  } else {
    html += `<p class="motion-note">No permanent details saved for this character yet.</p>`;
  }

  if (context.character.continuityNotes.length) {
    html +=
      `<p class="motion-note">Character notes:</p><ul class="ws-summary-list">` +
      context.character.continuityNotes
        .map(note => `<li>${novaEscape(note)}</li>`)
        .join("") +
      `</ul>`;
  } else {
    html += `<p class="motion-note">No character notes saved yet.</p>`;
  }

  if (context.project.rules.length) {
    html +=
      `<p class="motion-note">Continuity rules:</p><ul class="ws-summary-list">` +
      context.project.rules
        .map(rule => `<li>${novaEscape(rule)}</li>`)
        .join("") +
      `</ul>`;
  } else {
    html += `<p class="motion-note">No continuity rules saved for this project yet.</p>`;
  }

  if (context.project.notes.length) {
    html +=
      `<p class="motion-note">Project notes:</p><ul class="ws-summary-list">` +
      context.project.notes
        .map(note => `<li>${novaEscape(note)}</li>`)
        .join("") +
      `</ul>`;
  } else {
    html += `<p class="motion-note">No project notes saved yet.</p>`;
  }

  html += `<p class="motion-note">Reference image: ${context.character.imageAssetId ? "stored (not yet supplied to the provider)." : "none saved."}</p>`;

  if (warnings.length) {
    html += `<p><strong>Possible continuity conflicts</strong> <span class="motion-note">(rule-based checks — review them; warnings never block generation)</span></p>`;
    warnings.forEach(warning => {
      html +=
        `<div class="ws-warn"><span>${novaEscape(warning.message)}</span> ` +
        `<button class="ws-btn ws-warn-dismiss" data-nova-click="novaDismissContinuityWarning" data-nova-arg="${warning.key}">Dismiss</button></div>`;
    });
  }

  html += `<p><button class="ws-btn" data-nova-click="novaRenderProductionIdentity">Refresh continuity review</button></p>`;
  html += `</div>`;
  return html;
}

/* =====================================================================
   NOVA MOTION — Stage 3.5A: Visual Identity Manager
   ---------------------------------------------------------------------
   Who the characters are, what they look like, and how the production
   is rendered. Project-level visual styles (five presets + custom),
   plan styleBasis with historical precedence, cast identity lines,
   wardrobe / hair / accessory checks, and reference-image management.

   Design: 35-design.md Revision 3, Part I (Sections 3–10). 3.5B
   (Production State Manager) is NOT implemented here.

   Rules this section follows:
   - Deterministic rules only. No AI calls, no new dependencies.
   - Warnings never block and never rewrite the user's prompt.
   - Snapshots are immutable; the planner never silently repairs memory.
   - Reference images are STORED and RECORDED — never SUPPLIED to a
     provider. No UI text here promises face consistency from a saved
     image alone (Section 6).
   - The 3.4E context builder is protected: wardrobe / hair /
     accessories reach the checker and the scene line through
     novaAttachAppearanceToContext, which enriches a freshly built
     context from the stored character record.

   Integration points (see apply-35a.py):
   - buildMotionPlan() records styleBasis/version/cast/projectId,
     builds the cast identity line, and appends the style block.
   - novaContinuitySceneLine() gains wardrobe / hair / accessories.
   - novaCheckContinuityConflicts() gains the appearance checks.
   - novaRenderProductionIdentity() appends the style section.
   - novaCreateProject() gains the optional visualStyle argument.
   - novaCreateCharacter() stores wardrobe / hair / accessories.
   - Workspace forms gain the style step + appearance fields.
   ===================================================================== */

// ---- Visual style presets (Section 4.1, 7.5) --------------------------
// Fragments are the design's EXACT fixed texts. Distinctive markers
// are the design's fixed lists; adding a marker word is a design
// change, not an implementation choice. The shared set belongs to
// both realistic presets and never warns in either.
const NOVA_VISUAL_STYLE_PRESETS = {
  "photorealistic-human": {
    name: "Photorealistic Human",
    description: "Lifelike human characters — natural skin, realistic eyes, believable movement.",
    fragment: "Photorealistic human characters: natural skin texture with visible pores and fine detail, anatomically correct facial proportions, realistic eyes with natural iris detail and catchlights, believable hair with individual strands, physically plausible clothing fabric and drape, natural body movement, subtle lifelike expressions, and the same facial identity in every shot.",
    distinctiveMarkers: ["live-action", "human drama", "documentary", "real people", "real actors", "everyday life"]
  },
  "cinematic-fantasy": {
    name: "Cinematic Fantasy",
    description: "Lifelike fantasy — creatures and people with dramatic cinematic lighting.",
    fragment: "Cinematic photorealistic fantasy: lifelike creatures and people with natural skin, scale and feather texture, realistic eyes and believable movement, dramatic cinematic lighting, and the same face and form for every character in every shot.",
    distinctiveMarkers: ["fantasy", "magical", "dragons", "mythical", "epic fantasy", "otherworldly", "enchanted"]
  },
  "stylised-3d": {
    name: "Stylised 3D",
    description: "Stylised 3D animation — clean sculpted forms, expressive faces, vibrant colour.",
    fragment: "Stylised 3D animation: clean sculpted forms, expressive larger-than-life faces, smooth polished surfaces, vibrant colour, and the same character design in every shot.",
    distinctiveMarkers: ["3d animation", "pixar-style", "cgi", "cartoon", "claymation"]
  },
  "anime": {
    name: "Anime",
    description: "Anime — cel-shaded colour, large expressive eyes, dynamic poses.",
    fragment: "Anime style: cel-shaded colour, large expressive eyes, clean line work, dynamic poses, and the same character design in every shot.",
    distinctiveMarkers: ["anime", "manga", "japanese animation", "cel-shaded"]
  },
  "custom": {
    name: "Custom Direction",
    description: "Your own words describe the look.",
    fragment: null,
    distinctiveMarkers: []
  }
};

const NOVA_VISUAL_STYLE_SHARED_MARKERS = [
  "realistic", "photorealistic", "cinematic", "lifelike", "natural", "believable"
];

const NOVA_VISUAL_STYLE_DEFAULT_PRESET = "photorealistic-human";

// Preset keys in definition order (deterministic warning order).
const NOVA_VISUAL_STYLE_PRESET_KEYS = [
  "photorealistic-human",
  "cinematic-fantasy",
  "stylised-3d",
  "anime",
  "custom"
];

// ---- Reference-image strings (Section 6 — EXACT) ----------------------
// "Stored" vs "supplied" is the load-bearing distinction: STORED means
// the image is in this browser's IndexedDB and named in production
// records; SUPPLIED means it was handed to a generation provider.
// In 3.5, images are stored and recorded — never supplied.
const NOVA_REFERENCE_IMAGE_STRINGS = {
  formLabel: "Identity reference (saved for this character — supplied to the video provider when generation is connected)",
  reviewStatement: "Reference images are stored with the project. Face consistency at generation time depends on the connected video provider.",
  formHeader: "Reference image — stored in this browser.",
  formSubtext: "This image is saved with the character and recorded in production records. It is NOT sent to a video-generation provider yet — face consistency across generated clips is not available in this version.",
  reviewWithImage: "Reference image: stored (not yet supplied to the provider).",
  reviewWithoutImage: "Reference image: none saved.",
  jobView: "Reference image IDs recorded. Images were not supplied to a provider for this job."
};

// Style-lock consequence text (Section 4.4 — EXACT).
const NOVA_STYLE_CHANGE_CONSEQUENCES = "Changing the project style changes the visual direction of every scene that does not have its own override. Scene overrides are unaffected. Existing jobs keep the style they were created with. In-progress plans keep the style they were created with until you update them (Section 4.6).";

// Redundant-override refusal (Section 4.2 — EXACT).
const NOVA_STYLE_REDUNDANT_OVERRIDE = "This scene already uses that style — no override is needed.";

// ---- Style coercion + fragments (Sections 3.1, 4.1, 4.3) --------------

// Coerces a caller-supplied visualStyle value into a stored style
// record. Anything that is not a valid preset object yields the
// photorealistic-human default. Never throws.
function novaCoerceVisualStyle(value) {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    NOVA_VISUAL_STYLE_PRESETS[value.preset]
  ) {
    return {
      preset: value.preset,
      customDirection:
        typeof value.customDirection === "string" ? value.customDirection : ""
    };
  }
  return {
    preset: NOVA_VISUAL_STYLE_DEFAULT_PRESET,
    customDirection: ""
  };
}

// Read-time coercion ONLY — never writes (Section 4.3). A legacy
// string coerces to { preset: "custom", customDirection: <verbatim> }:
// PRESERVATION, not conversion — the string is never mapped to a
// named preset. A missing/empty/malformed style coerces to the
// photorealistic-human default. Always returns a fresh object.
function novaGetProjectVisualStyle(project) {
  const continuity =
    project &&
    project.continuity &&
    typeof project.continuity === "object" &&
    !Array.isArray(project.continuity)
      ? project.continuity
      : {};
  const vs = continuity.visualStyle;
  if (typeof vs === "string") {
    if (!vs) {
      return {
        preset: NOVA_VISUAL_STYLE_DEFAULT_PRESET,
        customDirection: ""
      };
    }
    return { preset: "custom", customDirection: vs };
  }
  if (vs && typeof vs === "object" && !Array.isArray(vs)) {
    return novaCoerceVisualStyle(vs);
  }
  return {
    preset: NOVA_VISUAL_STYLE_DEFAULT_PRESET,
    customDirection: ""
  };
}

// The fixed fragment for a preset, or the custom text verbatim.
// An unknown preset coerces to the default fragment (defensive;
// stored data is never trusted blindly).
function novaVisualStyleFragment(preset, customDirection) {
  if (preset === "custom") {
    return typeof customDirection === "string" ? customDirection : "";
  }
  const spec = NOVA_VISUAL_STYLE_PRESETS[preset];
  if (spec && spec.fragment) return spec.fragment;
  return NOVA_VISUAL_STYLE_PRESETS[NOVA_VISUAL_STYLE_DEFAULT_PRESET].fragment;
}

function novaPresetDisplayName(preset) {
  const spec = NOVA_VISUAL_STYLE_PRESETS[preset];
  return spec ? spec.name : preset;
}

// The legacy free-text form of a stored style, for the continuity
// form's style input: a string stays itself; a custom preset shows
// its direction; a named preset has no free-text form ("").
function novaLegacyStyleText(visualStyle) {
  if (typeof visualStyle === "string") return visualStyle;
  if (
    visualStyle &&
    typeof visualStyle === "object" &&
    visualStyle.preset === "custom"
  ) {
    return typeof visualStyle.customDirection === "string"
      ? visualStyle.customDirection
      : "";
  }
  return "";
}

// The continuity form's style input. Legacy string styles keep the
// editable text input (unchanged behaviour). Structured preset
// styles get a read-only input: the preset is managed in the Visual
// Style section, not here — an empty value on save keeps the preset.
function novaStyleLegacyInputHtml(visualStyle) {
  if (
    visualStyle &&
    typeof visualStyle === "object" &&
    !Array.isArray(visualStyle) &&
    NOVA_VISUAL_STYLE_PRESETS[visualStyle.preset]
  ) {
    const label =
      visualStyle.preset === "custom"
        ? "Custom direction — managed in the Visual Style section"
        : novaPresetDisplayName(visualStyle.preset) +
          " (preset — managed in the Visual Style section)";
    return `<input class="motion-input" id="wsContinuityStyle" type="text" value="" readonly placeholder="${novaEscape(label)}">`;
  }
  return `<input class="motion-input" id="wsContinuityStyle" type="text" value="${novaEscape(novaLegacyStyleText(visualStyle))}">`;
}

// ---- Plan style basis + historical precedence (Sections 3.4, 4.6) -----

// Legacy plans (created before 3.5A, no styleBasis) gain one from
// the current project style on first planner open. Returns true when
// it assigned a basis, false when the plan already had one (or no
// project was given). The assignment COPIES the project style; it
// never substitutes the default.
function novaEnsurePlanStyleBasis(plan, project) {
  if (!plan || plan.styleBasis) return false;
  if (!project) return false;
  plan.styleBasis = novaGetProjectVisualStyle(project);
  return true;
}

// The effective style for one scene (Section 4.6). Precedence:
// scene override > plan styleBasis > live project style >
// new-project default. Always returns a fresh object. Defensive at
// every level: a string styleBasis coerces to custom verbatim, an
// unknown preset coerces to the default.
function novaEffectiveSceneStyle(plan, project, scene) {
  if (
    scene &&
    scene.styleOverride &&
    typeof scene.styleOverride === "object" &&
    !Array.isArray(scene.styleOverride)
  ) {
    const o = scene.styleOverride;
    if (NOVA_VISUAL_STYLE_PRESETS[o.preset]) {
      return {
        preset: o.preset,
        customDirection:
          typeof o.customDirection === "string" ? o.customDirection : ""
      };
    }
  }
  if (plan && plan.styleBasis) {
    const b = plan.styleBasis;
    if (typeof b === "string") {
      return b
        ? { preset: "custom", customDirection: b }
        : {
            preset: NOVA_VISUAL_STYLE_DEFAULT_PRESET,
            customDirection: ""
          };
    }
    if (
      typeof b === "object" &&
      !Array.isArray(b) &&
      NOVA_VISUAL_STYLE_PRESETS[b.preset]
    ) {
      return {
        preset: b.preset,
        customDirection:
          typeof b.customDirection === "string" ? b.customDirection : ""
      };
    }
  }
  if (project) return novaGetProjectVisualStyle(project);
  return {
    preset: NOVA_VISUAL_STYLE_DEFAULT_PRESET,
    customDirection: ""
  };
}

// Adopting the live project style is explicit (Section 4.6): the
// review panel asks first (novaAskAdoptProjectStyle), and this
// function applies it — updates the plan's styleBasis and bumps the
// plan version, then rebuilds every scene prompt (their style
// blocks change) and refreshes the review + scene controls.
// Returns true when it adopted, false when there was nothing to do.
let novaStyleAdoptConfirm = false;

function novaAskAdoptProjectStyle() {
  novaStyleAdoptConfirm = true;
  novaRenderProductionIdentity();
}

function novaCancelAdoptProjectStyle() {
  novaStyleAdoptConfirm = false;
  novaRenderProductionIdentity();
}

function novaAdoptProjectStyle() {
  novaStyleAdoptConfirm = false;
  if (!novaMotionPlan || !novaMotionPlan.projectId) return false;
  const project = novaGetProject(novaMotionPlan.projectId);
  if (!project) return false;
  novaMotionPlan.styleBasis = novaGetProjectVisualStyle(project);
  novaMotionPlan.version = (novaMotionPlan.version || 1) + 1;
  if (Array.isArray(novaMotionPlan.scenes)) {
    novaMotionPlan.scenes.forEach((scene, index) => {
      novaRebuildScenePrompt(index);
    });
  }
  novaRenderProductionIdentity();
  novaRenderSceneContinuityControls();
  return true;
}

// ---- Cast validation + per-scene presence (Sections 3.2, 5.1) ---------

// Every cast id must exist AND belong to the project. Returns null
// when the cast is valid, or an error string naming the first bad id
// ("Character <id> is not in this project"). A non-array cast is
// treated as a failure, never coerced silently.
function novaValidateCast(project, cast) {
  if (!Array.isArray(cast)) return "The cast list is missing or invalid.";
  if (!project) return "The project is missing.";
  for (const id of cast) {
    const character = novaGetCharacter(id);
    if (!character) {
      return "Character " + id + " is not in this project.";
    }
    if (character.projectId !== project.id) {
      return "Character " + id + " is not in this project.";
    }
  }
  return null;
}

// Which characters appear in one scene. A missing charactersPresent
// field inherits the whole plan cast; an explicit empty list means
// NO characters are present; otherwise the listed subset is used.
// An id that fails validation produces an error naming the scene
// number and the id — fail-closed, never a silent drop.
function novaSceneCharacters(project, plan, scene) {
  if (!scene || typeof scene !== "object") {
    return { characters: [], error: "Scene is missing." };
  }
  if (scene.charactersPresent === undefined || scene.charactersPresent === null) {
    const cast = plan && Array.isArray(plan.cast) ? plan.cast : [];
    const castError = novaValidateCast(project, cast);
    if (castError) {
      return { characters: [], error: castError };
    }
    return {
      characters: cast
        .map((id) => novaGetCharacter(id))
        .filter((c) => c !== null && c !== undefined),
      error: null
    };
  }
  if (!Array.isArray(scene.charactersPresent)) {
    return {
      characters: [],
      error:
        "Scene " + (scene.number || "?") +
        ": the character list is not a list."
    };
  }
  if (scene.charactersPresent.length === 0) {
    return { characters: [], error: null };
  }
  const characters = [];
  for (const id of scene.charactersPresent) {
    const character = novaGetCharacter(id);
    if (!character || !project || character.projectId !== project.id) {
      return {
        characters: [],
        error:
          "Scene " + (scene.number || "?") +
          ": character " + id + " is not in this project."
      };
    }
    if (plan && Array.isArray(plan.cast) && !plan.cast.includes(id)) {
      return {
        characters: [],
        error:
          "Scene " + (scene.number || "?") +
          ": character " + id + " is not in this plan's cast."
      };
    }
    characters.push(character);
  }
  return { characters, error: null };
}

// ---- Cast identity lines (Sections 5.1, 13.5) ------------------------

// The project parts of a continuity line, in the EXACT formats of
// novaContinuitySceneLine. Project parts appear once, before the
// first character segment.
function novaProjectContinuityParts(project) {
  const parts = [];
  if (!project) return parts;
  if (project.name) {
    parts.push(
      "Project: " +
        project.name +
        (project.description ? " — " + project.description : "")
    );
  } else if (project.description) {
    parts.push("Project: " + project.description);
  }
  if (project.worldDescription) {
    parts.push("World: " + project.worldDescription);
  }
  if (project.visualStyle) {
    parts.push("Project visual style: " + project.visualStyle);
  }
  if (project.rules && project.rules.length) {
    parts.push("Project rules: " + project.rules.join("; "));
  }
  if (project.notes && project.notes.length) {
    parts.push("Project notes: " + project.notes.join("; "));
  }
  return parts;
}

// The character parts of a continuity line, in the EXACT formats of
// novaContinuitySceneLine — including the 3.5A wardrobe / hair /
// accessories blocks (after permanent details, before character
// notes). The context must have been enriched by
// novaAttachAppearanceToContext for those fields to appear.
function novaCharacterContinuityParts(context) {
  const parts = [];
  if (!context || !context.character) return parts;
  const character = context.character;
  if (character.name) {
    parts.push(
      "Character: " +
        character.name +
        " (version " +
        (character.version || 1) +
        ")" +
        (character.description ? " — " + character.description : "")
    );
  } else if (character.description) {
    parts.push("Character: " + character.description);
  }
  if (character.species) {
    parts.push("Species: " + character.species);
  }
  if (character.colors) {
    parts.push("Colors: " + character.colors);
  }
  if (character.distinctiveFeatures) {
    parts.push("Distinctive features: " + character.distinctiveFeatures);
  }
  if (character.permanentDetails && character.permanentDetails.length) {
    parts.push(
      "Permanent details: " + character.permanentDetails.join("; ")
    );
  }
  if (character.wardrobe) {
    parts.push("Wardrobe: " + character.wardrobe);
  }
  if (character.hair) {
    parts.push("Hair: " + character.hair);
  }
  if (character.accessories && character.accessories.length) {
    parts.push("Accessories: " + character.accessories.join("; "));
  }
  if (character.continuityNotes && character.continuityNotes.length) {
    parts.push("Character notes: " + character.continuityNotes.join("; "));
  }
  return parts;
}

// The cast identity lines for one scene (Section 5.1, Correction 1):
// ONE line per character, in cast order, each carrying the scene
// number — "Saved continuity (Scene N): ...". Project parts appear
// exactly ONCE, on the first character's line: A6 counts "both
// lines" for a two-character scene, so a separate project line
// (three lines for two characters) would contradict it, and the
// first line then keeps the 3.4E assembly order (project parts
// first, then the character segment). A character with no parts at
// all gets no line (there is nothing to say about them).
// The single-character case is EXACTLY the 3.4E line: it calls
// novaContinuitySceneLine directly (no scene number), so the A12
// byte-identity invariant holds by construction, not by parallel
// implementation. Returns an array of line strings (possibly
// empty); an explicitly empty presence list yields no lines.
function novaCastIdentityLines(contexts, sceneNumber) {
  if (!Array.isArray(contexts) || contexts.length === 0) return [];
  const valid = contexts.filter(
    (c) => c && c.character && c.project
  );
  if (valid.length === 0) return [];
  if (valid.length === 1) {
    const line = novaContinuitySceneLine(valid[0]);
    return line ? [line] : [];
  }
  const n =
    Number.isInteger(sceneNumber) && sceneNumber > 0 ? sceneNumber : 1;
  const projectParts = novaProjectContinuityParts(valid[0].project);
  const lines = [];
  valid.forEach((context, i) => {
    const charParts = novaCharacterContinuityParts(context);
    const parts = i === 0 ? projectParts.concat(charParts) : charParts;
    if (!parts.length) return;
    lines.push(
      "Saved continuity (Scene " + n + "): " + parts.join(". ") + "."
    );
  });
  return lines;
}

// Builds + enriches continuity contexts for a character list.
// Returns { contexts, error }. The error is a context-building
// error (from the protected builder) — the caller reports it.
function novaBuildCastContexts(project, characters) {
  if (!Array.isArray(characters) || characters.length === 0) {
    return { contexts: [], error: null };
  }
  const contexts = [];
  for (const character of characters) {
    const result = novaBuildContinuityContext(project.id, character.id);
    if (result.error) return { contexts: [], error: result.error };
    contexts.push(novaAttachAppearanceToContext(result.context, character));
  }
  return { contexts, error: null };
}

// Builds the identity lines for one scene from its characters:
// one line per character, in cast order (Correction 1). Returns
// { lines, error }. `lines` is an array (possibly empty); a
// single character yields the 3.4E line; an empty list yields
// no lines.
function novaBuildCastLines(project, characters, sceneNumber) {
  if (!Array.isArray(characters) || characters.length === 0) {
    return { lines: [], error: null };
  }
  const built = novaBuildCastContexts(project, characters);
  if (built.error) return { lines: [], error: built.error };
  return {
    lines: novaCastIdentityLines(built.contexts, sceneNumber),
    error: null
  };
}

// ---- Appearance enrichment (Section 5.2) ------------------------------

// The protected 3.4E context builder does not carry wardrobe / hair /
// accessories, so this enricher attaches them from the stored
// character record. Missing fields coerce to "" / [] (never throw).
// Returns the same context object, enriched.
function novaAttachAppearanceToContext(context, character) {
  if (!context || !context.character) return context;
  const appearance =
    character &&
    character.appearance &&
    typeof character.appearance === "object" &&
    !Array.isArray(character.appearance)
      ? character.appearance
      : {};
  context.character.wardrobe =
    typeof appearance.wardrobe === "string" ? appearance.wardrobe : "";
  context.character.hair =
    typeof appearance.hair === "string" ? appearance.hair : "";
  context.character.accessories = Array.isArray(appearance.accessories)
    ? appearance.accessories.filter((a) => typeof a === "string")
    : [];
  return context;
}

// ---- Appearance checks (Section 5.2) ----------------------------------

// Canonicalizes a matcher feature key: "braid" is hair, so a saved
// "black braid" and a prompt "blonde hair" compare on the same
// feature. Every other key passes through unchanged — the 3.4E
// matcher already singularizes its keys.
function novaAppearanceCanonicalFeature(feature) {
  const f = String(feature).toLowerCase();
  if (f === "braid") return "hair";
  return f;
}

// The feature a saved appearance part refers to: the last word of
// the part, SINGULARIZED ("leather boots" -> "boot", "iron ring" ->
// "ring", "long black braid" -> "braid"). The singular form is what
// the 3.4E matcher needs: it matches a plural token against a
// singular feature, and keys the result by the singular.
function novaAppearancePartFeature(part) {
  const words = String(part)
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  if (!words.length) return "";
  const last = words[words.length - 1];
  if (last.endsWith("s") && last.length > 2) return last.slice(0, -1);
  return last;
}

// Hair length words (Section 5.2 lexicon).
const NOVA_HAIR_LENGTH_WORDS = ["long", "short"];

// Extracts a hair length word from text, within 4 tokens of a hair
// word ("hair" or "braid"). Returns the length word or null.
function novaHairLengthNearHair(text) {
  const tokens = String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "hair" || tokens[i] === "braid" || tokens[i] === "braids") {
      for (let j = Math.max(0, i - 4); j < Math.min(tokens.length, i + 5); j++) {
        if (NOVA_HAIR_LENGTH_WORDS.includes(tokens[j])) return tokens[j];
      }
    }
  }
  return null;
}

// Appearance checks, called from novaCheckContinuityConflicts. The
// saved side gains wardrobe + hair + accessories, checked with the
// SAME 3.4E colour matcher (plus a dedicated hair-length check).
// Warnings follow the same { key, message } shape; the field-aware
// message says which saved field the contradiction is in. The
// `existingKeys` set guards against double-reporting a key the base
// checks already raised.
function novaCheckAppearanceConflicts(context, promptText, existingKeys) {
  const warnings = [];
  const character = context && context.character ? context.character : {};
  const prompt = typeof promptText === "string" ? promptText : "";

  const savedParts = [];
  if (character.wardrobe) {
    savedParts.push({ text: character.wardrobe, field: "wardrobe" });
  }
  if (character.hair) {
    savedParts.push({ text: character.hair, field: "hair" });
  }
  if (Array.isArray(character.accessories)) {
    character.accessories.forEach((a) => {
      if (a) savedParts.push({ text: a, field: "accessories" });
    });
  }
  if (savedParts.length === 0) return warnings;

  // --- Colour conflicts: 3.4E matcher, derived features ---------------
  // The matcher returns Map<feature, Set<color>>; both sides are
  // folded to canonical features ("braid" -> "hair") BEFORE the
  // comparison, so a saved "black braid" and a prompt "blonde hair"
  // meet on the same feature. The dedupe checks the canonical key
  // AND every raw-feature key, so a contradiction the base checker
  // already raised (under its raw feature) is never reported twice.
  const derivedFeatures = new Set();
  savedParts.forEach((part) => {
    const f = novaAppearancePartFeature(part.text);
    if (f) derivedFeatures.add(f);
  });
  if (derivedFeatures.size > 0) {
    const savedText = savedParts.map((p) => p.text).join(". ");
    const savedRaw = novaContinuityFeatureColors(
      savedText,
      Array.from(derivedFeatures)
    );
    const promptRaw = novaContinuityFeatureColors(
      prompt,
      Array.from(derivedFeatures)
    );
    const fold = (raw) => {
      const folded = new Map();
      raw.forEach((colorSet, feature) => {
        const canonical = novaAppearanceCanonicalFeature(feature);
        if (!folded.has(canonical)) {
          folded.set(canonical, { colors: new Set(), raw: new Set() });
        }
        folded.get(canonical).raw.add(feature);
        colorSet.forEach((color) => folded.get(canonical).colors.add(color));
      });
      return folded;
    };
    const saved = fold(savedRaw);
    const promptMap = fold(promptRaw);
    saved.forEach((savedEntry, canonical) => {
      const promptEntry = promptMap.get(canonical);
      if (!promptEntry) return;
      promptEntry.colors.forEach((promptColor) => {
        if (savedEntry.colors.has(promptColor)) return;
        savedEntry.colors.forEach((savedColor) => {
          const key =
            "color:" + canonical + ":" + savedColor + ":" + promptColor;
          const rawKeys = new Set([key]);
          savedEntry.raw.forEach((f) => {
            rawKeys.add("color:" + f + ":" + savedColor + ":" + promptColor);
          });
          promptEntry.raw.forEach((f) => {
            rawKeys.add("color:" + f + ":" + savedColor + ":" + promptColor);
          });
          if (
            existingKeys &&
            Array.from(rawKeys).some((k) => existingKeys.has(k))
          ) {
            return;
          }
          if (warnings.some((w) => w.key === key)) return;
          const part = savedParts.find((p) => {
            const pf = novaAppearanceCanonicalFeature(
              novaAppearancePartFeature(p.text)
            );
            return pf === canonical;
          });
          const field = part ? part.field : "wardrobe";
          warnings.push({
            key,
            kind: "appearance",
            message:
              "Prompt describes the " + canonical + " as " + promptColor +
              ", but the saved " + field + " says " + savedColor + "."
          });
        });
      });
    });
  }

  // --- Hair length conflicts ------------------------------------------
  if (character.hair) {
    const savedLength = novaHairLengthNearHair(character.hair);
    const promptLength = novaHairLengthNearHair(prompt);
    if (
      savedLength &&
      promptLength &&
      savedLength !== promptLength
    ) {
      const key = "length:hair:" + savedLength + ":" + promptLength;
      if (!existingKeys || !existingKeys.has(key)) {
        warnings.push({
          key,
          kind: "appearance",
          message:
            "Prompt describes the hair as " + promptLength +
            ", but the saved hair says " + savedLength + "."
        });
      }
    }
  }
  return warnings;
}

// ---- Style continuity check (Sections 7.1, 7.2, 7.4, 7.5) -------------

// Directive patterns (Section 7.1, fixed list). A marker warns
// ONLY inside one of these frames:
//   "in <style> style" / "in the style of <style>"
//   "render as <style>" / "rendered in <style>"
//   "<style> style:" at the start of the prompt or direction
//   "make it look like <style>" / "shot in <style>"
// "in X style" and "X style:" are covered by the bare "X style"
// pattern. Patterns are checked longest-first with an overlap
// guard, so "in the style of X" wins over "X style".
const NOVA_STYLE_DIRECTIVE_PATTERNS = [
  /render(?:ed|s|ing)?\s+as\s+(.+?)(?:\.|,|;|$)/ig,
  /render(?:ed|s|ing)?\s+in\s+(.+?)(?:\s+style\b|\.|,|;|$)/ig,
  /make\s+it\s+look\s+like\s+(.+?)(?:\s+style\b|\.|,|;|$)/ig,
  /shot\s+in\s+(.+?)(?:\s+style\b|\.|,|;|$)/ig,
  /in\s+the\s+style\s+of\s+(.+?)(?:\.|,|;|$)/ig,
  /\b(\S+)\s+style\b/ig
];

// Finds directive frames in the scene text. Each frame carries
// its matched text and character offsets. The marker test runs on
// the frame's token range (see novaCheckStyleContinuity).
function novaStyleDirectiveFrames(sceneText) {
  const text = typeof sceneText === "string" ? sceneText : "";
  const frames = [];
  const usedRanges = [];
  NOVA_STYLE_DIRECTIVE_PATTERNS.forEach((re) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      const overlaps = usedRanges.some((r) => start < r[1] && end > r[0]);
      if (overlaps) continue;
      usedRanges.push([start, end]);
      frames.push({ text: m[0], start, end });
    }
  });
  return frames;
}

// Tokenizes to lowercase word tokens with their character offsets
// (offsets are against the ORIGINAL text, so they align with the
// directive-frame offsets). Contractions are normalised ("don't"
// -> "dont") so the negation list can match them, and possessives
// are stripped ("dragon's" -> "dragon") so they do not match the
// plural "dragons" marker. Hyphens are token boundaries, so
// "pixar-style" and "pixar style" tokenize identically — hyphen vs
// space is orthography, not a different marker (the design's 7.5
// example "rendered in a pixar style" must resolve to the
// "pixar-style" marker).
function novaStyleTokens(text) {
  const tokens = [];
  const re = /[a-z0-9]+(?:'[a-z]+)?/g;
  let m;
  const lower = String(text).toLowerCase();
  while ((m = re.exec(lower)) !== null) {
    tokens.push({
      word: m[0].replace(/'s\b/g, "").replace(/'/g, ""),
      start: m.index,
      end: m.index + m[0].length
    });
  }
  return tokens;
}

// The distinctive-marker occurrences in a text, with the token
// index of each. Multi-word markers ("3d animation", "epic
// fantasy", "pixar-style") match on consecutive tokens; a
// hyphenated marker matches its space-separated form and vice
// versa.
function novaStyleMarkerOccurrences(text, markers) {
  const tokens = novaStyleTokens(text);
  const occurrences = [];
  markers.forEach((marker) => {
    const markerWords = marker.toLowerCase().split(/[\s-]+/).filter(Boolean);
    if (markerWords.length === 0) return;
    for (let i = 0; i + markerWords.length <= tokens.length; i++) {
      let match = true;
      for (let j = 0; j < markerWords.length; j++) {
        if (tokens[i + j].word !== markerWords[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        occurrences.push({ marker, tokenIndex: i, wordCount: markerWords.length });
      }
    }
  });
  return { tokens, occurrences };
}

// Suppression grounds (Section 7.2, exact lists).
const NOVA_STYLE_NEGATION_WORDS = [
  "not", "no", "never", "dont", "doesnt", "isnt", "avoid", "unlike"
];
const NOVA_STYLE_NEGATION_PHRASES = [["instead", "of"], ["rather", "than"]];
const NOVA_STYLE_NARRATIVE_WORDS = ["imagines", "remembers"];
const NOVA_STYLE_NARRATIVE_PHRASES = [
  ["dreams", "of"],
  ["a", "story", "about"],
  ["a", "tale", "of"]
];
const NOVA_STYLE_PROP_WORDS = [
  "poster", "painting", "picture", "book",
  "screen", "television", "photo", "photograph"
];

// True when a phrase (list of words) appears consecutively and
// OVERLAPS the token window [windowStart, windowEnd). A phrase
// counts as "within N tokens before the marker" when any of its
// words falls in the window — so "a story about" ending 2 tokens
// before the marker suppresses even though it starts 5 back.
function novaStylePhraseInWindow(tokens, phraseWords, windowStart, windowEnd) {
  const start = Math.max(0, windowStart);
  const end = Math.min(tokens.length, windowEnd);
  for (let i = 0; i + phraseWords.length <= tokens.length; i++) {
    if (i >= end) break;
    if (i + phraseWords.length <= start) continue;
    let match = true;
    for (let j = 0; j < phraseWords.length; j++) {
      if (tokens[i + j].word !== phraseWords[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

// The four suppression grounds (Section 7.2), checked around a
// marker occurrence at token index `markerIndex` (wordCount tokens
// long) in the FULL scene text. `frameStartIndex` is the token
// index where the directive frame begins (needed by the negation
// ground, which also covers the directive itself).
// (a) negation: a negation word or phrase within 3 tokens BEFORE
//     the marker OR before the directive ("Don't make it look
//     like a cartoon" negates the directive, not the marker);
// (b) quoted dialogue: the marker falls inside a quoted span
//     (odd quote count before it, counting both " and ' — the
//     documented approximate heuristic);
// (c) narrative frame: a narrative word or phrase within 4 tokens
//     BEFORE the marker;
// (d) prop reference: a prop word within 2 tokens before OR after
//     the marker. The design's rule text says "before", but its
//     own example ("A cartoon poster on the wall") has the prop
//     word AFTER the marker — the example governs, so both sides
//     are checked.
// Returns the ground name, or null when nothing suppresses.
function novaStyleSuppressionGround(tokens, fullText, markerIndex, wordCount, frameStartIndex) {
  // (a) negation — before the marker OR before the directive.
  const negationBefore = (endIndex) => {
    for (let j = Math.max(0, endIndex - 3); j < endIndex; j++) {
      if (NOVA_STYLE_NEGATION_WORDS.includes(tokens[j].word)) return true;
    }
    return NOVA_STYLE_NEGATION_PHRASES.some((phrase) =>
      novaStylePhraseInWindow(tokens, phrase, endIndex - 3, endIndex)
    );
  };
  if (negationBefore(markerIndex)) return "negation";
  if (
    typeof frameStartIndex === "number" &&
    frameStartIndex < markerIndex &&
    negationBefore(frameStartIndex)
  ) {
    return "negation";
  }
  // (b) quoted dialogue (odd-quote heuristic — documented in 7.2)
  const markerStart = tokens[markerIndex]
    ? tokens[markerIndex].start
    : fullText.length;
  const before = String(fullText).slice(0, markerStart);
  const quoteCount = (before.match(/["'\u201c\u201d\u2018\u2019]/g) || []).length;
  if (quoteCount % 2 === 1) return "quoted dialogue";
  // (c) narrative frame
  for (let j = Math.max(0, markerIndex - 4); j < markerIndex; j++) {
    if (NOVA_STYLE_NARRATIVE_WORDS.includes(tokens[j].word)) {
      return "narrative frame";
    }
  }
  if (
    NOVA_STYLE_NARRATIVE_PHRASES.some((phrase) =>
      novaStylePhraseInWindow(tokens, phrase, markerIndex - 4, markerIndex)
    )
  ) {
    return "narrative frame";
  }
  // (d) prop reference (either side — see the note above)
  for (
    let j = Math.max(0, markerIndex - 2);
    j < Math.min(tokens.length, markerIndex + wordCount + 2);
    j++
  ) {
    if (j >= markerIndex && j < markerIndex + wordCount) continue;
    if (NOVA_STYLE_PROP_WORDS.includes(tokens[j].word)) {
      return "prop reference";
    }
  }
  return null;
}

// The style continuity check (Sections 7.1, 7.2, 7.5).
// effectiveStyle is a { preset, customDirection } record (from
// novaEffectiveSceneStyle). A warning is raised ONLY when a
// DISTINCTIVE marker of another preset appears inside a directive
// frame, and none of the four suppression grounds applies. Shared
// markers ("realistic", "cinematic", ...) never warn in either
// realistic preset — they are not distinctive of any preset.
// Returns { warnings: [{ key, message, sceneNumber }] } — the key
// is "style:<effectivePreset>:<directedPreset>".
function novaCheckStyleContinuity(effectiveStyle, sceneText, sceneNumber) {
  const warnings = [];
  const preset =
    effectiveStyle && typeof effectiveStyle === "object"
      ? effectiveStyle.preset
      : NOVA_VISUAL_STYLE_DEFAULT_PRESET;
  // Custom styles have no markers: a custom scene's directives are
  // the user's own direction, not a contradiction.
  if (preset === "custom") return { warnings };
  const text = typeof sceneText === "string" ? sceneText : "";
  const frames = novaStyleDirectiveFrames(text);
  if (frames.length === 0) return { warnings };
  const tokens = novaStyleTokens(text);
  // Every distinctive-marker occurrence in the full text.
  const occurrences = [];
  NOVA_VISUAL_STYLE_PRESET_KEYS.forEach((markerPreset) => {
    const spec = NOVA_VISUAL_STYLE_PRESETS[markerPreset];
    if (!spec || !spec.distinctiveMarkers) return;
    const result = novaStyleMarkerOccurrences(text, spec.distinctiveMarkers);
    result.occurrences.forEach((o) => {
      occurrences.push({
        preset: markerPreset,
        marker: o.marker,
        tokenIndex: o.tokenIndex,
        wordCount: o.wordCount
      });
    });
  });
  const seenKeys = new Set();
  frames.forEach((frame) => {
    // The token index where this frame begins (for the negation
    // ground's "before the directive" window).
    let frameStartIndex = 0;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].start >= frame.start) {
        frameStartIndex = i;
        break;
      }
      frameStartIndex = i;
    }
    occurrences.forEach((occ) => {
      // The occurrence must OVERLAP this frame's character range.
      // Overlap (not containment) is the right test: a multi-word
      // marker such as "3d animation" spans the word before the
      // "X style" frame ("animation style"), so containment would
      // miss it. A marker fully outside the frame never warns.
      const first = tokens[occ.tokenIndex];
      const last = tokens[occ.tokenIndex + occ.wordCount - 1];
      if (!first || !last) return;
      if (last.end <= frame.start || first.start >= frame.end) return;
      if (occ.preset === preset) return;
      const ground = novaStyleSuppressionGround(
        tokens,
        text,
        occ.tokenIndex,
        occ.wordCount,
        frameStartIndex
      );
      if (ground) return;
      const key = "style:" + preset + ":" + occ.preset;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      warnings.push({
        key,
        message:
          "This scene asks for " + novaPresetDisplayName(occ.preset) +
          " style, but the project style is " + novaPresetDisplayName(preset) +
          ". Set a scene override if the change is intended.",
        sceneNumber: sceneNumber || null
      });
    });
  });
  return { warnings };
}

// ---- Scene prompt rebuild (Sections 4.2, 5.1) -------------------------

// Rebuilds one scene's generation prompt from the plan + scene
// records, applying the scene's current presence and override. The
// assembly mirrors buildMotionPlan exactly (same lines, same
// order): identity first, then style, then the fixed closing lines.
// The legacy "Visual style: <motionStyle>" line is preserved
// verbatim (locked tests pin it); the 3.5A style block is an
// additional separate line after the identity lines.
// Returns { prompt, error }.
function novaBuildScenePrompt(plan, scene, chain) {
  if (!plan || !scene) return { prompt: "", error: "Plan or scene is missing." };
  const project =
    plan.projectId ? novaGetProject(plan.projectId) : null;
  let identityLines = [];
  let styleBlock = "";
  let stateLine = "";
  if (project) {
    const presence = novaSceneCharacters(project, plan, scene);
    if (presence.error) return { prompt: "", error: presence.error };
    // The scene number for the identity lines (Correction 1): the
    // scene's own number when set (the rebuild path sets it), else
    // its position in the plan — a freshly built plan's scenes
    // carry no number field.
    let sceneNumber = 1;
    if (Number.isInteger(scene.number) && scene.number > 0) {
      sceneNumber = scene.number;
    } else if (plan.scenes) {
      const at = plan.scenes.indexOf(scene);
      if (at >= 0) sceneNumber = at + 1;
    }
    const castLines = novaBuildCastLines(
      project,
      presence.characters,
      sceneNumber
    );
    if (castLines.error) return { prompt: "", error: castLines.error };
    identityLines = castLines.lines;
    const effective = novaEffectiveSceneStyle(plan, project, scene);
    styleBlock =
      "Visual style: " +
      novaVisualStyleFragment(effective.preset, effective.customDirection);
    // Stage 3.5B: the state line (Section 12.4) — the
    // state carried into this scene plus its own changes.
    // A caller that already built the chain passes it in
    // (one build per plan); otherwise the chain is built
    // here. A broken chain yields no state line (the
    // caller that validates the chain reports the error;
    // the prompt builder never blocks a prompt on it).
    const stateChain = chain || novaBuildProductionState(project, plan);
    if (!stateChain.error) {
      const at = plan.scenes ? plan.scenes.indexOf(scene) : -1;
      if (at >= 0) {
        stateLine = novaContinuityStateLine(stateChain, scene, at);
      }
    }
  }
  const parts = [
    "Create a cinematic video scene.",
    "Original concept: " + (plan.prompt || ""),
    "Scene direction: " + (scene.direction || ""),
    "Visual style: " + (plan.style || ""),
    "Camera direction: " + (scene.camera || ""),
    "Preferred camera movement: " + (plan.camera || ""),
    "Subject movement: " + (scene.motion || ""),
    "Character continuity: " +
      (plan.character ||
        "Maintain the same subject identity and appearance throughout the sequence."),
    ...identityLines,
    ...(stateLine ? [stateLine] : []),
    ...(styleBlock ? [styleBlock] : []),
    "Environment and visual continuity must remain consistent with previous scenes.",
    "Aspect ratio: " + (plan.ratio || "")
  ];
  return { prompt: parts.join(" "), error: null };
}

// Rebuilds scene `index` of the current plan (after a presence or
// override change) and patches the displayed brief in place. The
// brief is patched by replacing the escaped old prompt with the
// escaped new prompt — the old prompt is unique to its scene.
// Returns true on success, false when the rebuild fails (the error
// is shown and the scene is left untouched).
function novaRebuildScenePrompt(index) {
  if (!novaMotionPlan || !Array.isArray(novaMotionPlan.scenes)) return false;
  const scene = novaMotionPlan.scenes[index];
  if (!scene) return false;
  scene.number = index + 1;
  const oldPrompt = scene.prompt;
  const rebuilt = novaBuildScenePrompt(novaMotionPlan, scene);
  if (rebuilt.error) {
    alert(rebuilt.error);
    return false;
  }
  scene.prompt = rebuilt.prompt;
  const output = document.getElementById("motionOutput");
  if (output && oldPrompt && oldPrompt !== rebuilt.prompt) {
    output.innerHTML = output.innerHTML.replace(
      novaEscape(oldPrompt),
      novaEscape(rebuilt.prompt)
    );
  }
  return true;
}

// ---- Style warnings for the current plan (Sections 7, 8) --------------

// Collects style-continuity warnings for every scene of a plan.
// Custom-override scenes are SKIPPED (Section 7.4) and reported
// separately in the skip list. Returns { warnings, skipped }.
function novaCollectStyleWarnings(plan, project) {
  const warnings = [];
  const skipped = [];
  if (!plan || !Array.isArray(plan.scenes) || !project) {
    return { warnings, skipped };
  }
  plan.scenes.forEach((scene, index) => {
    const sceneNumber = index + 1;
    const effective = novaEffectiveSceneStyle(plan, project, scene);
    const isCustomOverride =
      scene &&
      scene.styleOverride &&
      typeof scene.styleOverride === "object" &&
      scene.styleOverride.preset === "custom";
    if (isCustomOverride) {
      skipped.push(sceneNumber);
      return;
    }
    const result = novaCheckStyleContinuity(
      effective,
      scene.prompt || "",
      sceneNumber
    );
    result.warnings.forEach((w) => warnings.push(w));
  });
  return { warnings, skipped };
}

// ---- Style picker (Sections 4.1, 4.3, 4.4) ----------------------------

// The style-selection control: all five presets with one-line
// descriptions, plus a custom-direction textarea shown when the
// custom preset is selected. `idPrefix` distinguishes the project
// setup form ("wsNewStyle") from the workspace change flow
// ("wsChangeStyle"). `disabled` renders the locked (read-only)
// picker used by the workspace Visual Style section.
function novaStylePickerHtml(selectedPreset, customDirection, idPrefix, disabled) {
  const selected =
    NOVA_VISUAL_STYLE_PRESETS[selectedPreset] ? selectedPreset : NOVA_VISUAL_STYLE_DEFAULT_PRESET;
  const options = NOVA_VISUAL_STYLE_PRESET_KEYS.map((key) => {
    const spec = NOVA_VISUAL_STYLE_PRESETS[key];
    return (
      `<option value="${key}"${key === selected ? " selected" : ""}>` +
      `${novaEscape(spec.name)} — ${novaEscape(spec.description)}</option>`
    );
  }).join("");
  const customShown = selected === "custom";
  return (
    `<div class="motion-field">` +
    `<label class="motion-label" for="${idPrefix}Preset">Visual style</label>` +
    `<select class="motion-select" id="${idPrefix}Preset"${disabled ? " disabled" : ""} data-nova-change="novaStylePickerChanged" data-nova-arg="${idPrefix}">` +
    options +
    `</select></div>` +
    `<div class="motion-field ${customShown ? "nova-display-block" : "nova-display-none"}" id="${idPrefix}CustomWrap">` +
    `<label class="motion-label" for="${idPrefix}Custom">Custom direction</label>` +
    `<textarea class="motion-textarea" id="${idPrefix}Custom" rows="3" placeholder="Describe the look in your own words."${disabled ? " disabled" : ""}>${novaEscape(customDirection || "")}</textarea></div>`
  );
}

function novaStylePickerChanged(idPrefix) {
  const select = document.getElementById(idPrefix + "Preset");
  const wrap = document.getElementById(idPrefix + "CustomWrap");
  if (!select || !wrap) return;
  wrap.style.display = select.value === "custom" ? "block" : "none";
}

// Reads the picker's current value as a style record. Returns
// { preset, customDirection } — or null when the custom preset is
// selected but the direction is empty.
function novaReadStylePicker(idPrefix) {
  const select = document.getElementById(idPrefix + "Preset");
  if (!select) return null;
  const preset = select.value;
  if (!NOVA_VISUAL_STYLE_PRESETS[preset]) return null;
  let customDirection = "";
  if (preset === "custom") {
    const textarea = document.getElementById(idPrefix + "Custom");
    customDirection = textarea ? textarea.value.trim() : "";
    if (!customDirection) return null;
  }
  return { preset, customDirection };
}

// ---- Workspace Visual Style section (Sections 4.3, 4.4, 4.6) ----------

let novaStyleChangeOpen = false;

function novaStartStyleChange() {
  novaStyleChangeOpen = true;
  novaRenderWorkspace();
}

function novaCancelStyleChange() {
  novaStyleChangeOpen = false;
  novaRenderWorkspace();
}

// Saves the new style from the change picker. The picker is
// read-only by default and unlocks for ONE change, then re-locks
// after save (Section 4.4). A redundant change (same preset +
// same custom text as the current style) is refused with the
// design's message.
function novaSaveStyleChange() {
  const project = novaGetProject(novaWorkspaceProjectId);
  if (!project) return;
  const picked = novaReadStylePicker("wsChangeStyle");
  if (!picked) {
    const select = document.getElementById("wsChangeStylePreset");
    if (select && select.value === "custom") {
      alert("Enter a custom direction for the Custom style.");
    } else {
      alert("Choose a visual style.");
    }
    return;
  }
  const current = novaGetProjectVisualStyle(project);
  if (
    picked.preset === current.preset &&
    (picked.customDirection || "") === (current.customDirection || "")
  ) {
    alert(NOVA_STYLE_REDUNDANT_OVERRIDE);
    return;
  }
  const continuity =
    project.continuity && typeof project.continuity === "object"
      ? project.continuity
      : {};
  const updated = novaUpdateProject(project.id, {
    continuity: Object.assign({}, continuity, { visualStyle: picked })
  });
  if (!updated) {
    alert("The style could not be saved. Try again.");
    return;
  }
  novaStyleChangeOpen = false;
  novaRenderWorkspace();
}

// The Visual Style section of the project workspace: the locked
// picker (read-only by default, with a lock indicator), the
// "Change style" flow with the EXACT consequence text, and the
// style-basis note for in-progress plans.
function novaWorkspaceStyleSectionHtml(project) {
  if (!project) return "";
  const style = novaGetProjectVisualStyle(project);
  let html =
    `<div class="ws-continuity"><h3>Visual Style</h3>`;
  if (!novaStyleChangeOpen) {
    html +=
      `<p>Current style: <span class="ws-style-lock">Locked</span></p>` +
      novaStylePickerHtml(style.preset, style.customDirection, "wsChangeStyle", true) +
      `<p class="ws-style-fragment">${novaEscape(novaVisualStyleFragment(style.preset, style.customDirection))}</p>` +
      `<p><button class="motion-btn motion-btn-secondary" data-nova-click="novaStartStyleChange">Change style</button></p>`;
  } else {
    html +=
      `<p>${novaEscape(NOVA_STYLE_CHANGE_CONSEQUENCES)}</p>` +
      novaStylePickerHtml(style.preset, style.customDirection, "wsChangeStyle", false) +
      `<p><button class="motion-btn motion-btn-primary" data-nova-click="novaSaveStyleChange">Save style</button> ` +
      `<button class="motion-btn motion-btn-ghost" data-nova-click="novaCancelStyleChange">Cancel</button></p>`;
  }
  html +=
    `<p class="motion-note">In-progress plans keep the style they were created with until you update them (Section 4.6).</p>` +
    `</div>`;
  return html;
}

// ---- Production Identity style section (Sections 4.2, 4.6, 7, 8) ------

// The style section appended to the Production Identity review:
// the effective preset, the style-basis difference (when the plan
// was created under a different style), per-scene override flags,
// style warnings, and the custom-skip notes. Rendered only when a
// project is selected.
function novaProductionStyleSectionHtml(selected, project) {
  if (!selected || !project) return "";
  const plan = novaMotionPlan;
  if (!plan || !Array.isArray(plan.scenes)) return "";
  const basis = plan.styleBasis
    ? novaCoerceVisualStyle(plan.styleBasis)
    : novaGetProjectVisualStyle(project);
  const live = novaGetProjectVisualStyle(project);
  let html = `<div class="ws-continuity"><h3>Visual Style</h3>`;
  html +=
    `<p>Plan style: <strong>${novaEscape(novaPresetDisplayName(basis.preset))}</strong>` +
    (basis.preset === "custom" && basis.customDirection
      ? ` — ${novaEscape(basis.customDirection)}`
      : "") +
    `</p>`;
  // Basis difference (Section 4.6): the plan keeps the style it
  // was created under; adopting the live project style is explicit.
  if (
    basis.preset !== live.preset ||
    (basis.customDirection || "") !== (live.customDirection || "")
  ) {
    html +=
      `<p>Project style: ${novaEscape(live.preset)} (this plan uses ${novaEscape(basis.preset)} — created under that style.)</p>`;
    if (!novaStyleAdoptConfirm) {
      html +=
        `<p><button class="motion-btn motion-btn-secondary" data-nova-click="novaAskAdoptProjectStyle">Use current project style</button></p>`;
    } else {
      html +=
        `<p>Update this plan to the current project style (${novaEscape(novaPresetDisplayName(live.preset))})? Scene prompts will be rebuilt with the new style.</p>` +
        `<p><button class="motion-btn motion-btn-primary" data-nova-click="novaAdoptProjectStyle">Yes, update this plan</button> ` +
        `<button class="motion-btn motion-btn-ghost" data-nova-click="novaCancelAdoptProjectStyle">Keep the plan style</button></p>`;
    }
  }
  // Override flags (Section 4.2).
  plan.scenes.forEach((scene, index) => {
    if (
      scene &&
      scene.styleOverride &&
      typeof scene.styleOverride === "object" &&
      NOVA_VISUAL_STYLE_PRESETS[scene.styleOverride.preset]
    ) {
      html +=
        `<p>Scene ${index + 1} overrides the project style: ${novaEscape(scene.styleOverride.preset)} — reason: ${novaEscape(scene.styleOverride.reason || "")}.</p>`;
    }
  });
  // Style warnings + custom-skip notes (Sections 7.4, 8).
  const collected = novaCollectStyleWarnings(plan, project);
  collected.warnings.forEach((w) => {
    html +=
      `<p class="ws-warn">Scene ${w.sceneNumber || "?"}: ${novaEscape(w.message)}</p>`;
  });
  collected.skipped.forEach((sceneNumber) => {
    html +=
      `<p>Scene ${sceneNumber} uses a custom style — automatic style checks are skipped for this scene.</p>`;
  });
  html += `</div>`;
  return html;
}

// The job view's reference-image line (Section 6): shown for jobs
// whose snapshots record image ids — the character reference, the
// character snapshots, or the continuity context. The string is
// exact. Returns "" (no line at all) when no image id is recorded.
function novaJobReferenceImageLine(job) {
  if (!job) return "";
  let hasImage = false;
  if (job.characterRef && job.characterRef.imageAssetId) {
    hasImage = true;
  }
  if (!hasImage && Array.isArray(job.characterSnapshots)) {
    hasImage = job.characterSnapshots.some(
      (snap) => snap && snap.imageAssetId
    );
  }
  if (
    !hasImage &&
    job.continuityContext &&
    job.continuityContext.character &&
    job.continuityContext.character.imageAssetId
  ) {
    hasImage = true;
  }
  if (!hasImage) return "";
  return "<br>" + novaEscape(NOVA_REFERENCE_IMAGE_STRINGS.jobView);
}

// ---- Scene continuity controls (Sections 4.2, 5.1) ---------------------

// Per-scene presence + style-override controls, rendered into
// #motionSceneContinuity after a plan is built. Project plans only:
// standalone plans have no cast and no styleBasis, so nothing is
// rendered for them.
function novaRenderSceneContinuityControls() {
  const container = document.getElementById("motionSceneContinuity");
  if (!container) return;
  const plan = novaMotionPlan;
  if (!plan || !plan.projectId || !Array.isArray(plan.scenes)) {
    container.innerHTML = "";
    return;
  }
  const project = novaGetProject(plan.projectId);
  if (!project) {
    container.innerHTML = "";
    return;
  }
  const cast = Array.isArray(plan.cast) ? plan.cast : [];
  const castCharacters = cast
    .map((id) => novaGetCharacter(id))
    .filter((c) => c !== null && c !== undefined);
  let html = `<div class="ws-continuity"><h3>Scene Continuity</h3>`;
  plan.scenes.forEach((scene, index) => {
    html += novaSceneContinuityControlHtml(scene, index, castCharacters);
  });
  html += `</div>`;
  container.innerHTML = html;
}

// One scene's presence + override controls.
function novaSceneContinuityControlHtml(scene, index, castCharacters) {
  const sceneNumber = index + 1;
  const presence =
    scene.charactersPresent === undefined || scene.charactersPresent === null
      ? "inherit"
      : Array.isArray(scene.charactersPresent) && scene.charactersPresent.length === 0
        ? "none"
        : "choose";
  let html =
    `<div class="ws-scene-control"><h4>Scene ${sceneNumber}: ${novaEscape(scene.title || "")}</h4>` +
    `<div class="motion-field"><label class="motion-label" for="wsScenePresence_${index}">Characters in this scene</label>` +
    `<select class="motion-select" id="wsScenePresence_${index}" data-nova-change="novaSetScenePresence" data-nova-index="${index}" data-nova-value="1">` +
    `<option value="inherit"${presence === "inherit" ? " selected" : ""}>Inherit cast (all characters)</option>` +
    `<option value="choose"${presence === "choose" ? " selected" : ""}>Choose characters</option>` +
    `<option value="none"${presence === "none" ? " selected" : ""}>No characters</option>` +
    `</select></div>`;
  if (presence === "choose") {
    const present = Array.isArray(scene.charactersPresent)
      ? scene.charactersPresent
      : [];
    html += `<div class="ws-scene-cast">`;
    castCharacters.forEach((character) => {
      const checked = present.includes(character.id);
      html +=
        `<label class="ws-cast-check"><input type="checkbox" ${checked ? "checked" : ""} ` +
        `data-nova-change="novaSetSceneCharacters" data-nova-index="${index}" data-nova-arg="${novaEscape(character.id)}" data-nova-checked="1"> ` +
        `${novaEscape(character.name)}</label>`;
    });
    html += `</div>`;
  }
  html += novaSceneOverrideControlHtml(scene, index);
  html += `</div>`;
  return html;
}

// One scene's style-override control. The select lists "No override"
// plus the five presets; a chosen preset shows the reason input
// (required) and, for the custom preset, the custom-direction
// textarea. A scene that already has an override shows its values
// pre-filled, with Save (to update) and Clear buttons.
function novaSceneOverrideControlHtml(scene, index) {
  const override =
    scene.styleOverride &&
    typeof scene.styleOverride === "object" &&
    NOVA_VISUAL_STYLE_PRESETS[scene.styleOverride.preset]
      ? scene.styleOverride
      : null;
  const selected = override ? override.preset : "none";
  let html =
    `<div class="motion-field"><label class="motion-label" for="wsSceneOverridePreset_${index}">Style override</label>` +
    `<select class="motion-select" id="wsSceneOverridePreset_${index}" data-nova-change="novaSceneOverrideChanged" data-nova-index="${index}">` +
    `<option value="none"${selected === "none" ? " selected" : ""}>No override — use the plan style</option>`;
  NOVA_VISUAL_STYLE_PRESET_KEYS.forEach((key) => {
    const spec = NOVA_VISUAL_STYLE_PRESETS[key];
    html +=
      `<option value="${key}"${key === selected ? " selected" : ""}>${novaEscape(spec.name)}</option>`;
  });
  html += `</select></div>`;
  const fieldsShown = selected !== "none";
  html +=
    `<div id="wsSceneOverrideFields_${index}" class="${fieldsShown ? "nova-display-block" : "nova-display-none"}">` +
    `<div class="motion-field ${selected === "custom" ? "nova-display-block" : "nova-display-none"}" id="wsSceneOverrideCustomWrap_${index}">` +
    `<label class="motion-label" for="wsSceneOverrideCustom_${index}">Custom direction</label>` +
    `<textarea class="motion-textarea" id="wsSceneOverrideCustom_${index}" rows="2" placeholder="Describe the look in your own words.">${novaEscape(override && override.customDirection ? override.customDirection : "")}</textarea></div>` +
    `<div class="motion-field"><label class="motion-label" for="wsSceneOverrideReason_${index}">Reason (required)</label>` +
    `<input class="motion-input" id="wsSceneOverrideReason_${index}" type="text" placeholder="Why does this scene need a different style?" value="${novaEscape(override && override.reason ? override.reason : "")}"></div>` +
    `<p><button class="motion-btn motion-btn-primary" data-nova-click="novaSaveSceneOverride" data-nova-index="${index}">Save override</button>` +
    (override
      ? ` <button class="motion-btn motion-btn-ghost" data-nova-click="novaClearSceneOverride" data-nova-index="${index}">Clear override</button>`
      : "") +
    `</p></div>`;
  return html;
}

function novaSceneOverrideChanged(index) {
  const select = document.getElementById("wsSceneOverridePreset_" + index);
  const fields = document.getElementById("wsSceneOverrideFields_" + index);
  const customWrap = document.getElementById("wsSceneOverrideCustomWrap_" + index);
  if (!select || !fields) return;
  fields.style.display = select.value === "none" ? "none" : "block";
  if (customWrap) {
    customWrap.style.display = select.value === "custom" ? "block" : "none";
  }
}

// Presence selection (Section 5.1). "inherit" clears the scene's
// charactersPresent (whole cast); "none" sets an empty list (no
// characters); "choose" starts from the whole cast so the user can
// uncheck the ones that are absent. The scene prompt is rebuilt
// and the review + controls refresh.
function novaSetScenePresence(index, value) {
  if (!novaMotionPlan || !Array.isArray(novaMotionPlan.scenes)) return;
  const scene = novaMotionPlan.scenes[index];
  if (!scene) return;
  if (value === "inherit") {
    delete scene.charactersPresent;
  } else if (value === "none") {
    scene.charactersPresent = [];
  } else if (value === "choose") {
    const cast = Array.isArray(novaMotionPlan.cast) ? novaMotionPlan.cast : [];
    scene.charactersPresent = cast.slice();
  } else {
    return;
  }
  novaRebuildScenePrompt(index);
  novaRenderProductionIdentity();
  novaRenderSceneContinuityControls();
}

// Toggles one character in a scene's charactersPresent list. The
// list is created (from the whole cast) if the scene was inheriting.
function novaSetSceneCharacters(index, characterId, checked) {
  if (!novaMotionPlan || !Array.isArray(novaMotionPlan.scenes)) return;
  const scene = novaMotionPlan.scenes[index];
  if (!scene) return;
  if (!Array.isArray(scene.charactersPresent)) {
    const cast = Array.isArray(novaMotionPlan.cast) ? novaMotionPlan.cast : [];
    scene.charactersPresent = cast.slice();
  }
  if (checked) {
    if (!scene.charactersPresent.includes(characterId)) {
      scene.charactersPresent.push(characterId);
    }
  } else {
    scene.charactersPresent = scene.charactersPresent.filter(
      (id) => id !== characterId
    );
  }
  novaRebuildScenePrompt(index);
  novaRenderProductionIdentity();
  novaRenderSceneContinuityControls();
}

// Saves a scene's style override (Section 4.2). Refusals:
// - empty reason ("A reason is required for a style override.");
// - custom preset without a custom direction;
// - named preset carrying a custom direction (cannot happen via
//   the UI — the textarea is hidden — but the save path enforces
//   it anyway);
// - override identical to the inherited style (the design's exact
//   message).
// On success the scene prompt is rebuilt and the review +
// controls refresh.
function novaSaveSceneOverride(index) {
  if (!novaMotionPlan || !Array.isArray(novaMotionPlan.scenes)) return;
  const scene = novaMotionPlan.scenes[index];
  if (!scene) return;
  const select = document.getElementById("wsSceneOverridePreset_" + index);
  const reasonInput = document.getElementById("wsSceneOverrideReason_" + index);
  const customInput = document.getElementById("wsSceneOverrideCustom_" + index);
  if (!select || select.value === "none") {
    alert("Choose a style to override with, or leave the scene on the plan style.");
    return;
  }
  const preset = select.value;
  if (!NOVA_VISUAL_STYLE_PRESETS[preset]) {
    alert("That style is not available.");
    return;
  }
  const reason = reasonInput ? reasonInput.value.trim() : "";
  if (!reason) {
    alert("A reason is required for a style override.");
    return;
  }
  let customDirection = "";
  if (preset === "custom") {
    customDirection = customInput ? customInput.value.trim() : "";
    if (!customDirection) {
      alert("Enter a custom direction for the Custom style.");
      return;
    }
  } else if (customInput && customInput.value.trim()) {
    alert("A named style does not take a custom direction. Choose Custom to write your own direction.");
    return;
  }
  // Redundancy: an override identical to the inherited style is
  // refused (Section 4.2).
  const project = novaMotionPlan.projectId
    ? novaGetProject(novaMotionPlan.projectId)
    : null;
  const inherited = novaMotionPlan.styleBasis
    ? novaCoerceVisualStyle(novaMotionPlan.styleBasis)
    : project
      ? novaGetProjectVisualStyle(project)
      : {
          preset: NOVA_VISUAL_STYLE_DEFAULT_PRESET,
          customDirection: ""
        };
  if (
    preset === inherited.preset &&
    (customDirection || "") === (inherited.customDirection || "")
  ) {
    alert(NOVA_STYLE_REDUNDANT_OVERRIDE);
    return;
  }
  scene.styleOverride = { preset, customDirection, reason };
  novaRebuildScenePrompt(index);
  novaRenderProductionIdentity();
  novaRenderSceneContinuityControls();
}

function novaClearSceneOverride(index) {
  if (!novaMotionPlan || !Array.isArray(novaMotionPlan.scenes)) return;
  const scene = novaMotionPlan.scenes[index];
  if (!scene) return;
  delete scene.styleOverride;
  novaRebuildScenePrompt(index);
  novaRenderProductionIdentity();
  novaRenderSceneContinuityControls();
}

/* ---- End of Stage 3.5A: Visual Identity Manager ---------------------- */

/* =====================================================================
   NOVA MOTION — Stage 3.5B: Production State Manager
   ---------------------------------------------------------------------
   Design: 35-design.md Revision 3, Part II (Sections 11–24).
   Base: Stage 3.5A, COMMITTED as fe7a3d5.

   What the production remembers, scene by scene: stable scene ids,
   object + location tracking, character appearance state (wardrobe,
   hair, injuries, armour, notes) with reversal, the production
   state chain, deterministic warning fingerprints, user decisions
   (dismiss / mark intended) with canon-version revalidation, and
   the complete immutable production snapshot on every job.

   Rules this section follows:
   - Deterministic rules only. No AI calls, no new dependencies.
   - Warnings never block and never rewrite the user's prompt.
     (An INVALID STATE SEQUENCE blocks the build — Section 12.2 —
     because the chain cannot be computed, not because a warning
     fired.)
   - The state chain is PURE: same project + same plan always
     gives the same chain. It never writes to storage.
   - Snapshots are immutable; the planner never silently repairs
     memory. A corrupt plan errors fail-closed with a clear
     message naming the scene and the object or character.
   - The 3.4E context builder, conflict checker, scene line and
     dismissal are UNTOUCHED. The 3.5A functions are UNTOUCHED
     except novaBuildScenePrompt (extended: the state line) —
     see apply-35b.py and verify-35b-protected.js.
   - Reference images are STORED and RECORDED — never SUPPLIED
     to a provider (Section 6, capability 3 — still a future
     backend milestone).

   Per-scene check text (decision D22 — see the implementation
   report): the object, appearance, 3.4E and location checks run
   against the scene's TITLE + DIRECTION, not the built scene
   prompt. The built prompt contains the identity lines (canon)
   and the state line (effective state); scanning it would make
   every check compare the system's own injected text against
   itself (the state line mentions a lost object by design; the
   identity line carries the canon wardrobe). The style check
   keeps the built prompt (3.5A behaviour — style directives
   live in the direction and the style block, and the identity
   and state lines carry no style markers).

   Integration points (see apply-35b.py):
   - buildMotionPlan() assigns scene ids at creation, builds
     the state chain once per plan, rebuilds the scene prompts
     through the shared builder (state line: Identity -> State
     -> Style), and renders the per-scene state controls.
   - novaBuildScenePrompt() gains the state line (same builder
     the plan uses, so the two can never drift).
   - novaUpdateProject() / novaUpdateCharacter() bump
     project.canonVersion on canon changes (Section 16.2).
   - novaWorkspaceSaveContinuity() preserves the objects /
     locations lists (they are owned by the Objects & Locations
     section, not the continuity editor).
   - novaWorkspaceProjectDetailHtml() gains the Objects &
     Locations section.
   - novaRenderProductionIdentity() appends the production
     continuity section (Section 16.3).
   - novaCreateProjectJob() revalidates decisions BEFORE
     snapshotting (Section 16.2, trigger 3) and snapshots
     job.productionContinuity (Section 17).
   - generateMotionVideo() pre-checks decisions before creating
     a project job and asks the user to confirm when
     revalidation removed any.
   ===================================================================== */

// Dismissed warning fingerprints, current session only. A reload
// starts with an empty set, so a dismissed warning never hides a
// conflict from a future session silently. Dismissal is keyed by
// FINGERPRINT (Section 15.4): a warning is hidden only while its
// CURRENT fingerprint matches a dismissed fingerprint, so a
// warning that CHANGED re-appears.
let novaDismissedWarningFingerprints = new Set();

// The last creation-time revalidation report (Section 16.2,
// trigger 3): { removed: [...], invalidated: [...] }. Set by
// novaCreateProjectJob's internal revalidation so the creation
// flow (and the tests) can report removals.
let novaLastCreationRevalidation = { removed: [], invalidated: [] };

// One-shot flag: the user confirmed creation after revalidation
// removed decisions (generateMotionVideo consumes it).
let novaMotionCreationConfirmed = false;

// The last refresh/lazy revalidation report, shown in the
// production continuity section: { removed, invalidated } or null.
let novaLastRevalidationReport = null;

// The warnings from the most recent production-continuity
// collection, keyed by fingerprint for the Dismiss / Mark-intended
// handlers. Rebuilt on every review render.
let novaCurrentPlanWarnings = [];

// Workspace Objects & Locations: the object/location awaiting a
// two-step delete confirmation, or null.
// { type: "object" | "location", id: <objectId> | <location name> }
let novaWorkspaceObjectDeleteTarget = null;

// The object currently being edited in the workspace form, or null.
let novaWorkspaceEditingObjectId = null;

// The location currently being edited in the workspace form (by
// name — locations are name-keyed, Section 12.1), or null.
let novaWorkspaceEditingLocationName = null;

// Notice shown in the state controls after a scene deletion
// (Section 16.2: "This scene had N continuity decision(s), which
// will be removed."). Cleared on the next render.
let novaSceneDeleteNotice = "";

// ---- Fixed lexicons (design Sections 12.2, 14) ----------------------

// The transition table (Section 12.2). `from` is the required
// pre-state; `to` is the resulting status (null for move —
// location only, status unchanged).
const NOVA_OBJECT_TRANSITIONS = {
  lose: { from: ["present"], to: "lost" },
  recover: { from: ["lost"], to: "present" },
  damage: { from: ["present"], to: "damaged" },
  destroy: { from: ["present", "damaged"], to: "destroyed" },
  move: { from: ["present"], to: null },
  repair: { from: ["damaged"], to: "present" }
};

// Location-transition markers (Section 14 — small fixed lexicon).
const NOVA_LOCATION_TRANSITION_MARKERS = [
  "later",
  "cut to",
  "the next day",
  "meanwhile",
  "arrives at"
];

// Appearance-change fields (Section 13.1).
const NOVA_APPEARANCE_FIELDS = [
  "wardrobe",
  "hair",
  "injury",
  "armour",
  "general"
];

// Stop words dropped when extracting descriptive words from an
// appearance value or a prompt description (Section 13.5 —
// decision D3 in the implementation report).
const NOVA_STATE_WORD_STOP = new Set([
  "the", "a", "an", "and", "or", "but", "of", "at", "in", "on",
  "with", "to", "from", "by", "for", "is", "it", "its", "his",
  "her", "their", "he", "she", "they", "as", "was", "were"
]);

// Verbs that commonly sit next to a garment word in a scene
// direction ("Theron wears a red cloak") but describe an action,
// not the garment. Excluded from the PROMPT's descriptive words
// only (decision D27) — a saved wardrobe value is never a verb
// phrase, so the value side needs no such list. Participles that
// double as adjectives (flowing, torn, worn, faded) are NOT here:
// they are genuine descriptors when they appear. (Rev 5: the
// closed lexicon below is the deciding filter — of these, torn,
// worn and faded are lexicon words; flowing is not, so it is
// ignored at the comparison site.)
const NOVA_APPEARANCE_VERB_STOP = new Set([
  "wear", "wears", "wearing", "wore",
  "walk", "walks", "walking", "walked",
  "stand", "stands", "standing", "stood",
  "sit", "sits", "sitting", "sat",
  "hold", "holds", "holding", "held",
  "carry", "carries", "carrying", "carried",
  "put", "puts", "putting",
  "take", "takes", "taking", "took",
  "pull", "pulls", "pulling", "pulled",
  "remove", "removes", "removing", "removed",
  "adjust", "adjusts", "adjusting", "adjusted"
]);

// The closed appearance-state lexicon (Section 13.4, Rev 4/5).
// These ten words — and ONLY these — participate in the
// state-word comparison in novaCheckAppearanceContinuity. The
// +/-4-token window and the stop lists above are the pre-filter;
// this lexicon is the DECIDING filter: a candidate word not in
// the lexicon is ignored, never a warning. Matching is LITERAL
// on the listed forms — inflected forms (burn, burning,
// tearing) are NOT in the list and never match (burning is not
// burned). Adding a word is a DESIGN CHANGE: do not extend
// this list in code.
const NOVA_APPEARANCE_STATE_LEXICON = new Set([
  "clean", "dirty", "torn", "patched", "burned", "wet",
  "faded", "worn", "damaged", "stained"
]);

// ---- Small helpers ---------------------------------------------------

function novaDeepCopy35b(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function novaNewSceneId() {
  return novaNewId("nova-scene");
}

function novaNewObjectId() {
  return novaNewId("nova-object");
}

function novaNewChangeId(prefix) {
  return novaNewId(prefix || "nova-objchg");
}

// Normalised text for name/location matching: lowercase, collapsed
// whitespace, non-alphanumerics treated as separators.
function novaNormalize35b(text) {
  if (typeof text !== "string") return "";
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// True when `name` is mentioned in `text`. Multi-word names match
// as a normalised substring; single-word names match whole words
// only (Section 15.2, locked decision).
function novaObjectNameMentioned(name, text) {
  const needle = novaNormalize35b(name);
  if (!needle) return false;
  const haystack = " " + novaNormalize35b(text) + " ";
  if (needle.indexOf(" ") < 0) {
    return haystack.indexOf(" " + needle + " ") >= 0;
  }
  return haystack.indexOf(needle) >= 0;
}

// True when the text contains one of the fixed location-transition
// markers (Section 14), matched as whole phrases.
function novaLocationMarkersPresent(text) {
  const haystack = " " + novaNormalize35b(text) + " ";
  return NOVA_LOCATION_TRANSITION_MARKERS.some(marker =>
    haystack.indexOf(" " + marker + " ") >= 0
  );
}

// ---- Registry + canon-version helpers (Sections 12.1, 16.2) ----------

// The project's objects, deep-copied; missing coerces to [] (no
// checks run, no errors — Section 21).
function novaGetProjectObjects(project) {
  if (
    !project ||
    !project.continuity ||
    !Array.isArray(project.continuity.objects)
  ) {
    return [];
  }
  return novaDeepCopy35b(project.continuity.objects).filter(
    item => item && typeof item === "object" && typeof item.id === "string"
  );
}

// The project's locations, deep-copied; missing coerces to [].
function novaGetProjectLocations(project) {
  if (
    !project ||
    !project.continuity ||
    !Array.isArray(project.continuity.locations)
  ) {
    return [];
  }
  return novaDeepCopy35b(project.continuity.locations).filter(
    item => item && typeof item === "object" && typeof item.name === "string"
  );
}

// The project's canon version; legacy projects (no canonVersion)
// start at 1 (Section 16.2). Null-safe.
function novaGetProjectCanonVersion(project) {
  if (
    !project ||
    typeof project.canonVersion !== "number" ||
    project.canonVersion < 1
  ) {
    return 1;
  }
  return Math.floor(project.canonVersion);
}

// Bumps the project's canonVersion by one and saves it. Returns
// true on success, false when the project no longer exists or
// the save failed.
function novaBumpProjectCanonVersion(projectId) {
  const project = projectId ? novaGetProject(projectId) : null;
  if (!project) return false;
  const updated = {
    ...project,
    canonVersion: novaGetProjectCanonVersion(project) + 1,
    updatedAt: new Date().toISOString()
  };
  return novaSaveProject(updated);
}

// True when the new continuity record changes anything the checks
// read (Section 16.2): worldDescription (the era check reads it
// — decision D6), visualStyle, rules, notes, objects, locations.
// Deep-compared as JSON; the values are plain data.
function novaContinuityCanonChanged(oldContinuity, newContinuity) {
  const oldC =
    oldContinuity && typeof oldContinuity === "object" ? oldContinuity : {};
  const newC =
    newContinuity && typeof newContinuity === "object" ? newContinuity : {};
  const fields = [
    "worldDescription",
    "visualStyle",
    "rules",
    "notes",
    "objects",
    "locations"
  ];
  return fields.some(
    field =>
      JSON.stringify(oldC[field] === undefined ? null : oldC[field]) !==
      JSON.stringify(newC[field] === undefined ? null : newC[field])
  );
}

// True when the new appearance record changes anything the checks
// read (Section 16.2): species, colours, permanent details,
// wardrobe, hair, accessories. distinctiveFeatures is NOT read by
// any check and is NOT in the design's list — it does not bump.
function novaAppearanceCanonChanged(oldAppearance, newAppearance) {
  const oldA =
    oldAppearance && typeof oldAppearance === "object" ? oldAppearance : {};
  const newA =
    newAppearance && typeof newAppearance === "object" ? newAppearance : {};
  const fields = [
    "species",
    "colors",
    "permanentDetails",
    "wardrobe",
    "hair",
    "accessories"
  ];
  return fields.some(
    field =>
      JSON.stringify(oldA[field] === undefined ? null : oldA[field]) !==
      JSON.stringify(newA[field] === undefined ? null : newA[field])
  );
}

// ---- Stable scene IDs (Section 11 / 11.1) ----------------------------

// Assigns stable ids to scenes lacking them and repairs collisions.
// The fixed first-open sequence (Section 11.1): (1) the plan is
// already loaded by the caller; (2) validate uniqueness and repair
// collisions BEFORE assigning new ids and BEFORE saving (the later
// scene in scene order is re-assigned a fresh id — the repair
// cannot itself collide with an id assigned in the same pass);
// (3) assign ids to scenes lacking them; (4) the caller saves once
// (there is no plan store yet — see decision D1 — so `needsSave`
// is reported to the caller and the notices are shown).
// Decisions attached to a colliding id stay with the FIRST scene
// (the one that keeps the id); the re-assigned scene starts with
// no decisions — by construction, since decisions are keyed by
// sceneId and only the first scene keeps it.
// Returns { needsSave, assigned, collisions, notices } where
// collisions is [{ sceneId, keptTitle, newTitle }] and notices
// are the exact Section 11 / 11.1 notice strings.
function novaAssignSceneIds(plan) {
  const result = { needsSave: false, assigned: 0, collisions: [], notices: [] };
  if (!plan || !Array.isArray(plan.scenes)) return result;

  // Step 2: collision repair first.
  const seen = new Map(); // sceneId -> first scene index
  plan.scenes.forEach((scene, index) => {
    if (!scene || typeof scene !== "object") return;
    const id = scene.id;
    if (typeof id !== "string" || !id) return;
    if (!seen.has(id)) {
      seen.set(id, index);
      return;
    }
    // A later scene shares the id: re-assign it a fresh one.
    const keptScene = plan.scenes[seen.get(id)];
    const keptTitle =
      keptScene && keptScene.title ? keptScene.title : "Scene " + (seen.get(id) + 1);
    const newTitle = scene.title ? scene.title : "Scene " + (index + 1);
    let fresh = novaNewSceneId();
    while (seen.has(fresh)) fresh = novaNewSceneId();
    scene.id = fresh;
    seen.set(fresh, index);
    result.needsSave = true;
    result.collisions.push({ sceneId: id, keptTitle, newTitle });
    result.notices.push(
      "Two scenes shared an ID — '" +
        newTitle +
        "' has been given a new ID. Continuity decisions stay with '" +
        keptTitle +
        "'."
    );
  });

  // Step 3: assign ids to scenes lacking them.
  plan.scenes.forEach(scene => {
    if (!scene || typeof scene !== "object") return;
    if (typeof scene.id === "string" && scene.id) return;
    let fresh = novaNewSceneId();
    while (seen.has(fresh)) fresh = novaNewSceneId();
    scene.id = fresh;
    seen.set(fresh, true);
    result.needsSave = true;
    result.assigned += 1;
  });

  // The legacy-assignment notice (Section 11, exact text) is owed
  // when ids were ASSIGNED to existing scenes — not for a fresh
  // plan, whose scenes get ids at creation (B1). The caller
  // decides whether the plan is legacy: novaOpenPlan adds the
  // notice; buildMotionPlan does not (it creates the scenes).
  return result;
}

// Copies a plan (Section 11.1): regenerates ALL scene ids in the
// copy and drops ALL decisions. Decisions belong to the original
// plan's warnings; the copy's scenes are new scenes, so the old
// decisions cannot attach to them. The copy starts at version 1
// with a fresh watermark (no decisions to revalidate).
function novaCopyPlan(plan) {
  if (!plan || typeof plan !== "object") return null;
  const copy = novaDeepCopy35b(plan);
  if (Array.isArray(copy.scenes)) {
    copy.scenes.forEach(scene => {
      if (scene && typeof scene === "object") {
        scene.id = novaNewSceneId();
      }
    });
  }
  copy.version = 1;
  copy.continuityDecisions = [];
  copy.decisionsCheckedAt = {
    planVersion: 1,
    canonVersion:
      plan.decisionsCheckedAt &&
      typeof plan.decisionsCheckedAt.canonVersion === "number"
        ? plan.decisionsCheckedAt.canonVersion
        : 1
  };
  return copy;
}

// Lazily initialises the 3.5 plan fields on a plan record
// (Section 3.4 / 21): version starts at 1; styleBasis is set from
// the current project style; decisionsCheckedAt starts at the
// current versions (no revalidation is owed for a plan that has
// no decisions yet); continuityDecisions starts empty. Returns
// true when anything was initialised.
function novaEnsurePlanContinuityFields(plan, project) {
  if (!plan || typeof plan !== "object") return false;
  let changed = false;
  if (typeof plan.version !== "number" || plan.version < 1) {
    plan.version = 1;
    changed = true;
  }
  if (!plan.styleBasis && project) {
    plan.styleBasis = novaGetProjectVisualStyle(project);
    changed = true;
  }
  if (!Array.isArray(plan.continuityDecisions)) {
    plan.continuityDecisions = [];
    changed = true;
  }
  if (
    !plan.decisionsCheckedAt ||
    typeof plan.decisionsCheckedAt !== "object"
  ) {
    plan.decisionsCheckedAt = {
      planVersion: plan.version,
      canonVersion: novaGetProjectCanonVersion(project)
    };
    changed = true;
  }
  return changed;
}

// The first-open sequence for a plan (Sections 11, 11.1, 16.2
// trigger 1): assign scene ids + repair collisions, initialise
// the 3.5 fields, then — if the watermark moved — revalidate the
// decisions against the current canon + plan. Returns
// { needsSave, notices, revalidated, removed, invalidated }.
// `notices` carries the Section 11 assignment notice (when ids
// were assigned to existing scenes) plus any collision notices.
function novaOpenPlan(plan, project) {
  const result = {
    needsSave: false,
    notices: [],
    revalidated: false,
    removed: [],
    invalidated: []
  };
  if (!plan || typeof plan !== "object") return result;

  const ids = novaAssignSceneIds(plan);
  if (ids.needsSave) result.needsSave = true;
  if (ids.assigned > 0) {
    result.notices.push(
      "This plan's scenes now have stable IDs, so continuity decisions stay with the right scene if you reorder them."
    );
  }
  ids.notices.forEach(notice => result.notices.push(notice));

  if (novaEnsurePlanContinuityFields(plan, project)) {
    result.needsSave = true;
  }

  // Lazy revalidation (trigger 1): compare the watermark with the
  // current versions; revalidate only if either moved.
  const lazy = novaLazyRevalidatePlan(project, plan);
  if (lazy.revalidated && lazy.revalidation) {
    result.revalidated = true;
    // The revalidation folds both outcomes into `removed`
    // (each entry carries reason "vanished" | "changed"); the
    // open result splits them into the design's vocabulary
    // (Section 16.2): vanished = removed, changed = invalidated.
    const removed = lazy.revalidation.removed || [];
    result.removed = removed.filter(r => r.reason !== "changed");
    result.invalidated = removed.filter(r => r.reason === "changed");
    if (removed.length) {
      result.needsSave = true;
    }
  }
  return result;
}

// ---- Object transition validation (Section 12.2) ---------------------

// Checks one declaration against the transition table. `object`
// is the object's CURRENT STATE record ({ status, ... }) — the
// table is keyed by pre-state — or a plain status string (decision
// D8: the Section 18 signature says `object`, and the state record
// is the only object that carries a status). Returns an error
// string or null. A `move` with no destination is refused;
// newLocation is ignored for every other transition (a stray
// value is dropped by the caller, never stored).
function novaValidateObjectChange(object, transition, newLocation) {
  const status =
    typeof object === "string"
      ? object
      : object && typeof object === "object"
        ? object.status
        : undefined;
  const spec = NOVA_OBJECT_TRANSITIONS[transition];
  if (!spec) {
    return "Unknown object transition: " + transition + ".";
  }
  if (spec.from.indexOf(status) < 0) {
    if (status === "destroyed") {
      return "A destroyed object cannot change again — destruction is terminal.";
    }
    return (
      "Cannot " +
      transition +
      " an object that is " +
      (status || "unknown") +
      " — " +
      transition +
      " requires the object to be " +
      spec.from.join(" or ") +
      "."
    );
  }
  if (transition === "move") {
    if (typeof newLocation !== "string" || !newLocation.trim()) {
      return "A move needs a destination — where does the object go?";
    }
  }
  return null;
}

// Validates a scene's stateChanges array against a starting object
// state ({ <objectId>: { status, ... } }), applying each change in
// ARRAY order with running-state validation (Section 12.2). Also
// refuses an unknown objectId (it must exist in the project
// registry). Returns an error string or null. `sceneLabel` (e.g.
// "Scene 3") names the scene in the error.
function novaValidateObjectChangeList(project, startingState, changes, sceneLabel) {
  const label = sceneLabel || "This scene";
  if (!Array.isArray(changes)) return null;
  const registry = new Set(novaGetProjectObjects(project).map(o => o.id));
  const running = {};
  Object.keys(startingState || {}).forEach(id => {
    running[id] = { status: startingState[id].status };
  });
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    if (!change || typeof change !== "object") {
      return label + ": an object change is not a change record.";
    }
    if (!registry.has(change.objectId)) {
      return (
        label +
        " names an object that is not in this project's registry: " +
        change.objectId +
        "."
      );
    }
    if (!running[change.objectId]) {
      running[change.objectId] = { status: "present" };
    }
    const error = novaValidateObjectChange(
      running[change.objectId],
      change.transition,
      change.newLocation
    );
    if (error) {
      const name = novaObjectNameById(project, change.objectId);
      return label + ": " + error + " (" + name + ")";
    }
    const spec = NOVA_OBJECT_TRANSITIONS[change.transition];
    if (spec.to) running[change.objectId].status = spec.to;
  }
  return null;
}

// The registry name for an object id (or the id itself when the
// object is gone — the error still names something).
function novaObjectNameById(project, objectId) {
  const found = novaGetProjectObjects(project).find(o => o.id === objectId);
  return found ? found.name : objectId;
}

// ---- The production state chain (Section 14) -------------------------

// Pure state-chain builder: objects + appearance + locations.
// Input: project canon (objects, locations, characters) + plan
// (scenes in order, each with stateChanges, characterStateChanges,
// location). Output: per-scene accumulated state — one entry per
// scene, { sceneId, sceneNumber, location, objects, appearance },
// where objects/appearance are the state AFTER that scene.
// `starting` is the canon starting state (all objects present at
// home locations, characters in default wardrobe, no injuries).
// Each entry also carries `carriedIn` (the state before the
// scene's changes — what Section 12.3 checks run against) plus
// internal provenance maps (appearanceProvenance,
// appearanceTemporary, objectLastTransition,
// locationSetBySceneId) used by the state line and the warnings; those internal fields are NOT part of
// the Section 17 snapshot shape (the snapshot stores only
// { location, objects, appearance } per scene).
// The builder validates defensively and reports a clear error
// naming the scene and the object or character rather than
// producing a corrupt chain. On error it returns
// { error, scenes: null, starting: null, sceneNumberById: {} }.
function novaBuildProductionState(project, plan) {
  const failure = error => ({
    error,
    scenes: null,
    starting: null,
    sceneNumberById: {}
  });
  if (!project || typeof project !== "object") {
    return failure("No project was supplied for the state chain.");
  }
  if (!plan || !Array.isArray(plan.scenes)) {
    return failure("No plan scenes were supplied for the state chain.");
  }

  // Scene ids are required: the chain, the warnings and the
  // decisions all key by sceneId (Section 11). A scene without
  // one is a malformed plan — fail closed.
  for (let i = 0; i < plan.scenes.length; i++) {
    const scene = plan.scenes[i];
    if (!scene || typeof scene !== "object") {
      return failure("Scene " + (i + 1) + " is not a scene record.");
    }
    if (typeof scene.id !== "string" || !scene.id) {
      return failure(
        "Scene " +
          (i + 1) +
          " has no stable ID. Open the plan to assign IDs first."
      );
    }
  }

  // The cast must validate (Section 3.3, fail-closed): every id
  // must exist AND belong to the project. A standalone plan (no
  // cast) has no characters to initialise.
  const cast = Array.isArray(plan.cast) ? plan.cast : [];
  const castError = novaValidateCast(project, cast);
  if (castError) {
    return failure(castError);
  }
  const castCharacters = cast
    .map(id => novaGetCharacter(id))
    .filter(Boolean);

  // Starting state: canon.
  const objects = novaGetProjectObjects(project);
  const startingObjects = {};
  objects.forEach(object => {
    startingObjects[object.id] = {
      objectId: object.id,
      status: "present",
      currentLocation:
        typeof object.homeLocation === "string" ? object.homeLocation : "",
      lastChangedSceneId: null
    };
  });
  const startingAppearance = {};
  castCharacters.forEach(character => {
    const appearance = character.appearance || {};
    startingAppearance[character.id] = {
      wardrobe: typeof appearance.wardrobe === "string" ? appearance.wardrobe : "",
      hair: typeof appearance.hair === "string" ? appearance.hair : "",
      injuries: [],
      armour: "",
      notes: []
    };
  });
  const starting = {
    location: null,
    objects: novaDeepCopy35b(startingObjects),
    appearance: novaDeepCopy35b(startingAppearance)
  };

  // Running state + history. The history maps changeId ->
  // { field, previousValue } for single-value fields and
  // changeId -> the added text for injuries/notes, so a reversal
  // restores the EXACT pre-change value (Section 13.3). `reversed`
  // tracks changeIds already reversed (a second reversal of the
  // same change is refused). `reversalIds` tracks the changeIds
  // of reversals themselves: a reversal cannot itself be
  // reversed (decision D23 — the design defines reversal for
  // forward changes only). `appearanceTemporary` tracks whether
  // the current value of each field / injury / note came from an
  // unreversed temporary change (decision D11: the state line
  // marks it "(temporary)"); the history records the
  // pre-change temporariness so a reversal restores it exactly.
  const runningObjects = novaDeepCopy35b(startingObjects);
  const runningAppearance = novaDeepCopy35b(startingAppearance);
  const appearanceHistory = {}; // changeId -> { characterId, field, previousValue | addedText, previousTemporary }
  const appearanceReversed = new Set();
  const appearanceReversalIds = new Set();
  const appearanceProvenance = {}; // characterId -> { wardrobe, hair, armour, injuries: {text: sceneId}, notes: {text: sceneId} }
  const appearanceTemporary = {}; // characterId -> { wardrobe, hair, armour, injuries: {text: bool}, notes: {text: bool} }
  castCharacters.forEach(character => {
    appearanceProvenance[character.id] = {
      wardrobe: null,
      hair: null,
      armour: null,
      injuries: {},
      notes: {}
    };
    appearanceTemporary[character.id] = {
      wardrobe: false,
      hair: false,
      armour: false,
      injuries: {},
      notes: {}
    };
  });
  const objectLastTransition = {}; // objectId -> transition
  let runningLocation = null;
  let locationSetBySceneId = null;

  const sceneNumberById = {};
  plan.scenes.forEach((scene, index) => {
    sceneNumberById[scene.id] = index + 1;
  });

  const entries = [];

  for (let index = 0; index < plan.scenes.length; index++) {
    const scene = plan.scenes[index];
    const sceneNumber = index + 1;
    const label = "Scene " + sceneNumber;

    // The state carried INTO this scene (Section 12.3, step 1).
    // The transition and provenance maps are snapshotted here
    // too: the state line's carried sentences describe the state
    // BEFORE this scene's changes, so they must read the
    // carried-in maps, not the entry's after-state maps.
    const carriedIn = {
      location: runningLocation,
      objects: novaDeepCopy35b(runningObjects),
      appearance: novaDeepCopy35b(runningAppearance),
      objectLastTransition: { ...objectLastTransition },
      appearanceProvenance: novaDeepCopy35b(appearanceProvenance),
      appearanceTemporary: novaDeepCopy35b(appearanceTemporary),
      locationSetBySceneId
    };

    // --- Object changes, in array order, with running-state
    // validation (Section 12.2).
    const stateChanges = Array.isArray(scene.stateChanges)
      ? scene.stateChanges
      : [];
    for (let c = 0; c < stateChanges.length; c++) {
      const change = stateChanges[c];
      if (!change || typeof change !== "object") {
        return failure(label + ": an object change is not a change record.");
      }
      const object = objects.find(o => o.id === change.objectId);
      if (!object) {
        return failure(
          label +
            " names an object that is not in this project's registry: " +
            change.objectId +
            "."
        );
      }
      const current = runningObjects[change.objectId];
      const error = novaValidateObjectChange(
        current,
        change.transition,
        change.newLocation
      );
      if (error) {
        return failure(label + ": " + error + " (" + object.name + ")");
      }
      const spec = NOVA_OBJECT_TRANSITIONS[change.transition];
      if (spec.to) current.status = spec.to;
      if (change.transition === "move") {
        current.currentLocation = change.newLocation.trim();
      }
      current.lastChangedSceneId = scene.id;
      objectLastTransition[change.objectId] = change.transition;
    }

    // --- Appearance changes, in array order (Section 13).
    const appearanceChanges = Array.isArray(scene.characterStateChanges)
      ? scene.characterStateChanges
      : [];
    for (let c = 0; c < appearanceChanges.length; c++) {
      const change = appearanceChanges[c];
      if (!change || typeof change !== "object") {
        return failure(label + ": an appearance change is not a change record.");
      }
      if (NOVA_APPEARANCE_FIELDS.indexOf(change.field) < 0) {
        return failure(
          label + ": unknown appearance field: " + change.field + "."
        );
      }
      if (!cast.includes(change.characterId)) {
        const name =
          (novaGetCharacter(change.characterId) || {}).name ||
          change.characterId;
        return failure(
          label +
            " changes the appearance of " +
            name +
            ", who is not in this plan's cast."
        );
      }
      const state = runningAppearance[change.characterId];
      const provenance = appearanceProvenance[change.characterId];
      const temporary = appearanceTemporary[change.characterId];

      if (change.reversesChangeId) {
        // Reversal: the closed five-part refusal list
        // (Section 13.3, Rev 4/5) — the named change must exist
        // in the history (an earlier scene, or earlier in this
        // scene's array), belong to the same character, target
        // the SAME FIELD, not have been reversed already, and
        // not itself be a reversal (decision D23). Any failure
        // refuses the whole build; nothing is modified.
        if (appearanceReversalIds.has(change.reversesChangeId)) {
          return failure(
            label +
              ": a reversal cannot itself be reversed: " +
              change.reversesChangeId +
              "."
          );
        }
        const original = appearanceHistory[change.reversesChangeId];
        if (!original) {
          return failure(
            label +
              ": reverses a change that was never made: " +
              change.reversesChangeId +
              "."
          );
        }
        if (original.characterId !== change.characterId) {
          return failure(
            label +
              ": reverses a change belonging to another character."
          );
        }
        if (original.field !== change.field) {
          return failure(
            label +
              ": reverses a change to another field (" +
              original.field +
              ", not " +
              change.field +
              ")."
          );
        }
        if (appearanceReversed.has(change.reversesChangeId)) {
          return failure(
            label +
              ": reverses the same change twice: " +
              change.reversesChangeId +
              "."
          );
        }
        appearanceReversed.add(change.reversesChangeId);
        if (typeof change.changeId === "string" && change.changeId) {
          appearanceReversalIds.add(change.changeId);
        }
        // Restore the EXACT pre-change value from history
        // (decision D4: the reversal's own `change` field is
        // recorded but does not govern the restored value).
        // The pre-change temporariness is restored with it.
        if (change.field === "injury") {
          const at = state.injuries.indexOf(original.addedText);
          if (at >= 0) state.injuries.splice(at, 1);
          delete provenance.injuries[original.addedText];
          delete temporary.injuries[original.addedText];
        } else if (change.field === "general") {
          const at = state.notes.indexOf(original.addedText);
          if (at >= 0) state.notes.splice(at, 1);
          delete provenance.notes[original.addedText];
          delete temporary.notes[original.addedText];
        } else {
          state[change.field] = original.previousValue;
          provenance[change.field] = scene.id;
          temporary[change.field] = !!original.previousTemporary;
        }
        continue;
      }

      // A non-reversal change states the NEW effective
      // description (Section 13.1) — it must not be empty.
      if (typeof change.change !== "string" || !change.change.trim()) {
        return failure(
          label + ": an appearance change needs the new description."
        );
      }
      const changeId =
        typeof change.changeId === "string" && change.changeId
          ? change.changeId
          : null;
      const isTemporary = !!change.temporary;
      if (change.field === "injury") {
        state.injuries.push(change.change.trim());
        provenance.injuries[change.change.trim()] = scene.id;
        temporary.injuries[change.change.trim()] = isTemporary;
        if (changeId) {
          appearanceHistory[changeId] = {
            characterId: change.characterId,
            field: "injury",
            addedText: change.change.trim()
          };
        }
      } else if (change.field === "general") {
        state.notes.push(change.change.trim());
        provenance.notes[change.change.trim()] = scene.id;
        temporary.notes[change.change.trim()] = isTemporary;
        if (changeId) {
          appearanceHistory[changeId] = {
            characterId: change.characterId,
            field: "general",
            addedText: change.change.trim()
          };
        }
      } else {
        if (changeId) {
          appearanceHistory[changeId] = {
            characterId: change.characterId,
            field: change.field,
            previousValue: state[change.field],
            previousTemporary: !!temporary[change.field]
          };
        }
        state[change.field] = change.change.trim();
        provenance[change.field] = scene.id;
        temporary[change.field] = isTemporary;
      }
    }

    // --- Location: the scene's location is free text, optionally
    // picked from the project list (Section 14). A scene that
    // sets one moves the production there; otherwise the carried
    // location continues.
    if (typeof scene.location === "string" && scene.location.trim()) {
      runningLocation = scene.location.trim();
      locationSetBySceneId = scene.id;
    }

    entries.push({
      sceneId: scene.id,
      sceneNumber,
      location: runningLocation,
      objects: novaDeepCopy35b(runningObjects),
      appearance: novaDeepCopy35b(runningAppearance),
      carriedIn,
      appearanceProvenance: novaDeepCopy35b(appearanceProvenance),
      appearanceTemporary: novaDeepCopy35b(appearanceTemporary),
      objectLastTransition: { ...objectLastTransition },
      locationSetBySceneId
    });
  }

  return { error: null, scenes: entries, starting, sceneNumberById, _project: project };
}

// The state carried INTO scene `index` (0-based): the starting
// state for scene 0, else the previous entry's after-state.
function novaChainCarriedIn(chain, index) {
  if (!chain || !Array.isArray(chain.scenes)) return null;
  if (index <= 0) return chain.starting;
  const previous = chain.scenes[index - 1];
  if (!previous) return chain.starting;
  return {
    location: previous.location,
    objects: previous.objects,
    appearance: previous.appearance
  };
}

// ---- The state line (Section 12.4) -----------------------------------

// The scene number for a sceneId, from the chain's map
// ("Scene 3" — display labels only, derived at render time).
function novaSceneNumberLabel(chain, sceneId) {
  if (!chain || !chain.sceneNumberById) return "Scene ?";
  const n = chain.sceneNumberById[sceneId];
  return "Scene " + (typeof n === "number" ? n : "?");
}

// The owner name for an object (from the registry), or "".
function novaObjectOwnerName(project, object) {
  if (!object || !object.ownerCharacterId) return "";
  const owner = novaGetCharacter(object.ownerCharacterId);
  return owner ? owner.name : "";
}

// One carried-state sentence for an object, or "" when the object
// is not carried-relevant for this scene. An object is listed
// when its status is not present, when an earlier scene changed
// it, or when this scene changes it (Section 12.4: only CHANGED
// or CARRIED-RELEVANT state is listed).
function novaStateLineObjectSentence(chain, entry, object, project, sceneChangesObject) {
  const state = entry.carriedIn.objects[object.id];
  if (!state) return "";
  const changedByEarlierScene = state.lastChangedSceneId !== null;
  const isPresent = state.status === "present";
  if (isPresent && !changedByEarlierScene && !sceneChangesObject) return "";

  const name = object.name;
  const sceneLabel = state.lastChangedSceneId
    ? novaSceneNumberLabel(chain, state.lastChangedSceneId)
    : null;
  const lastTransition = entry.carriedIn.objectLastTransition
    ? entry.carriedIn.objectLastTransition[object.id]
    : null;
  const owner = novaObjectOwnerName(project, object);
  const where = owner
    ? "with " + owner
    : state.currentLocation
      ? "in " + state.currentLocation
      : "";

  if (state.status === "lost") {
    return "The " + name + " was lost in " + sceneLabel + ".";
  }
  if (state.status === "destroyed") {
    return "The " + name + " was destroyed in " + sceneLabel + ".";
  }
  if (state.status === "damaged") {
    return "The " + name + " is damaged (" + sceneLabel + ").";
  }
  // Present.
  if (lastTransition === "recover") {
    return (
      "The " + name + " is " + (where || "present") +
      " (recovered in " + sceneLabel + ")."
    );
  }
  if (lastTransition === "repair") {
    return (
      "The " + name + " is " + (where || "present") +
      " (repaired in " + sceneLabel + ")."
    );
  }
  if (lastTransition === "move") {
    return (
      "The " + name + " is in " + state.currentLocation +
      " (moved in " + sceneLabel + ")."
    );
  }
  return "The " + name + " is " + (where || "present") + ".";
}

// Carried-state sentences for one character's appearance: every
// field that differs from canon (changed by an earlier scene),
// every current injury, every note, and every field this scene
// changes (the carried "before" picture). Each fact names the
// scene it comes from. `canon` is the character's canon
// appearance (wardrobe/hair); `temporary` maps field -> true when
// the current value comes from an unreversed temporary change.
function novaStateLineAppearanceSentences(chain, entry, character, canon, sceneChangesFields) {
  const sentences = [];
  const state = entry.carriedIn.appearance[character.id];
  if (!state) return sentences;
  const provenance = entry.carriedIn.appearanceProvenance
    ? entry.carriedIn.appearanceProvenance[character.id]
    : null;
  const temporary = entry.carriedIn.appearanceTemporary
    ? entry.carriedIn.appearanceTemporary[character.id]
    : null;
  const name = character.name || "The character";
  const fields = [
    { key: "wardrobe", label: "wardrobe" },
    { key: "hair", label: "hair" },
    { key: "armour", label: "armour" }
  ];
  fields.forEach(field => {
    const canonValue =
      field.key === "armour" ? "" : canon[field.key] || "";
    const differs = state[field.key] !== canonValue;
    const changedHere =
      sceneChangesFields && sceneChangesFields[field.key];
    if (!differs && !changedHere) return;
    if (!state[field.key]) return;
    const sceneId = provenance ? provenance[field.key] : null;
    const sceneLabel = sceneId
      ? " (" + novaSceneNumberLabel(chain, sceneId) + ")"
      : "";
    // Unreversed temporary changes carry " (temporary)" in the
    // state line (decision D11).
    const tempMark =
      temporary && temporary[field.key] ? " (temporary)" : "";
    sentences.push(
      name + "'s " + field.label + ": " + state[field.key] + tempMark + sceneLabel + "."
    );
  });
  state.injuries.forEach(injury => {
    const sceneId =
      provenance && provenance.injuries ? provenance.injuries[injury] : null;
    const sceneLabel = sceneId
      ? " (" + novaSceneNumberLabel(chain, sceneId) + ")"
      : "";
    const tempMark =
      temporary && temporary.injuries && temporary.injuries[injury]
        ? " (temporary)"
        : "";
    sentences.push(name + " has an injury: " + injury + tempMark + sceneLabel + ".");
  });
  state.notes.forEach(note => {
    const sceneId =
      provenance && provenance.notes ? provenance.notes[note] : null;
    const sceneLabel = sceneId
      ? " (" + novaSceneNumberLabel(chain, sceneId) + ")"
      : "";
    const tempMark =
      temporary && temporary.notes && temporary.notes[note]
        ? " (temporary)"
        : "";
    sentences.push(name + " — " + note + tempMark + sceneLabel + ".");
  });
  return sentences;
}

// The two-part state line for scene `sceneIndex` (0-based):
// the state carried INTO the scene plus the scene's own changes
// (Section 12.4). Returns "" when there is no carried state and
// no changes. `chain` is the novaBuildProductionState result;
// `scene` is the plan's scene record (its declarations).
function novaContinuityStateLine(chain, scene, sceneIndex) {
  if (!chain || !Array.isArray(chain.scenes)) return "";
  const entry = chain.scenes[sceneIndex];
  if (!entry) return "";
  const sceneNumber = entry.sceneNumber || sceneIndex + 1;
  const project = chain._project || null;

  // Which objects / appearance fields does this scene change?
  const sceneObjectIds = new Set();
  (scene && Array.isArray(scene.stateChanges) ? scene.stateChanges : []).forEach(
    change => {
      if (change && change.objectId) sceneObjectIds.add(change.objectId);
    }
  );
  const sceneAppearanceFields = {}; // characterId -> { field: true }
  (scene && Array.isArray(scene.characterStateChanges)
    ? scene.characterStateChanges
    : []
  ).forEach(change => {
    if (!change || !change.characterId || !change.field) return;
    if (!sceneAppearanceFields[change.characterId]) {
      sceneAppearanceFields[change.characterId] = {};
    }
    sceneAppearanceFields[change.characterId][change.field] = true;
  });

  // --- Part 1: carried state.
  const carried = [];
  if (project) {
    novaGetProjectObjects(project).forEach(object => {
      const sentence = novaStateLineObjectSentence(
        chain,
        entry,
        object,
        project,
        sceneObjectIds.has(object.id)
      );
      if (sentence) carried.push(sentence);
    });
    Object.keys(entry.carriedIn.appearance).forEach(characterId => {
      const character = novaGetCharacter(characterId);
      if (!character) return;
      const canon = character.appearance || {};
      novaStateLineAppearanceSentences(
        chain,
        entry,
        character,
        canon,
        sceneAppearanceFields[characterId] || null
      ).forEach(sentence => carried.push(sentence));
    });
  }

  // --- Part 2: this scene's own changes.
  const own = [];
  (scene && Array.isArray(scene.stateChanges) ? scene.stateChanges : []).forEach(
    change => {
      if (!change || typeof change !== "object") return;
      const name = project
        ? novaObjectNameById(project, change.objectId)
        : change.objectId;
      let sentence = "";
      if (change.transition === "lose") {
        sentence = "the " + name + " is lost";
      } else if (change.transition === "recover") {
        sentence = "the " + name + " is recovered";
      } else if (change.transition === "damage") {
        sentence = "the " + name + " is damaged";
      } else if (change.transition === "destroy") {
        sentence = "the " + name + " is destroyed";
      } else if (change.transition === "move") {
        sentence =
          "the " + name + " moves to " + (change.newLocation || "").trim();
      } else if (change.transition === "repair") {
        sentence = "the " + name + " is repaired";
      } else {
        return;
      }
      if (typeof change.note === "string" && change.note.trim()) {
        let note = change.note.trim();
        if (!/[.!?]$/.test(note)) note += ".";
        sentence += ". " + note;
      } else {
        sentence += ".";
      }
      own.push(sentence);
    }
  );
  (scene && Array.isArray(scene.characterStateChanges)
    ? scene.characterStateChanges
    : []
  ).forEach(change => {
    if (!change || typeof change !== "object") return;
    const character = novaGetCharacter(change.characterId);
    const name = character ? character.name : change.characterId;
    if (change.reversesChangeId) {
      // The restored value comes from the chain's after-state
      // (history governs — decision D4).
      const after = entry.appearance[change.characterId] || {};
      if (change.field === "injury") {
        own.push(name + "'s injury heals.");
      } else if (change.field === "general") {
        own.push(name + "'s note is removed.");
      } else {
        const restored = after[change.field] || "";
        own.push(
          name + "'s " + change.field + " is restored" +
            (restored ? ": " + restored : "") +
            "."
        );
      }
      return;
    }
    const text = (change.change || "").trim();
    if (!text) return;
    const temp = change.temporary ? " (temporary)" : "";
    if (change.field === "injury") {
      own.push(name + " gains an injury: " + text + temp + ".");
    } else if (change.field === "general") {
      own.push(name + " — " + text + temp + ".");
    } else {
      own.push(name + "'s " + change.field + " becomes: " + text + temp + ".");
    }
  });

  if (!carried.length && !own.length) return "";
  let line = "Current state (Scene " + sceneNumber + "): ";
  if (carried.length) line += carried.join(" ");
  if (own.length) {
    if (carried.length) line += "\n";
    line += "In this scene " + own.join(" ");
    // The own sentences already end with periods (each is a
    // complete sentence); the join above puts them in sequence.
  }
  return line;
}

// ---- Deterministic warning fingerprints (Section 15.4) ---------------

// FNV-1a 32-bit hash, rendered as 8 lowercase hex characters.
// ~10 lines of plain JavaScript: no dependency, no crypto API,
// deterministic across reloads, browsers and sessions.
function novaFnv1a32(text) {
  let hash = 0x811c9dc5;
  const input = typeof text === "string" ? text : "";
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// fingerprint = "w:" + fnv1a32(kind + "|" + sceneId + "|" + key +
// "|" + stableRef + "|" + provenance). The rendered message and
// the scene number are EXCLUDED (renames and reorders never
// change fingerprints). stableRef is "" when none. Pure.
function novaComputeWarningFingerprint(kind, sceneId, key, stableRef, provenance) {
  const canonical =
    (kind || "") +
    "|" +
    (sceneId || "") +
    "|" +
    (key || "") +
    "|" +
    (stableRef || "") +
    "|" +
    (provenance || "canon");
  return "w:" + novaFnv1a32(canonical);
}

// Returns a copy of the warning with its fingerprint attached.
function novaWarningWithFingerprint(warning) {
  const copy = { ...warning };
  copy.fingerprint = novaComputeWarningFingerprint(
    copy.kind,
    copy.sceneId,
    copy.key,
    copy.stableRef,
    copy.provenance
  );
  return copy;
}

// ---- Per-scene check text (decision D22) ------------------------------

// The text the per-scene checks run against: the scene's title +
// direction. NOT the built scene prompt (see the module header).
function novaCheckSceneText(scene) {
  if (!scene || typeof scene !== "object") return "";
  const parts = [];
  if (typeof scene.title === "string" && scene.title.trim()) {
    parts.push(scene.title.trim());
  }
  if (typeof scene.direction === "string" && scene.direction.trim()) {
    parts.push(scene.direction.trim());
  }
  return parts.join(" ");
}

// ---- Object-state checks (Section 15.2) -------------------------------

// Object-state warnings for one scene. `checkState` is the
// carried-in object state ({ objects: { <id>: { status,
// currentLocation, lastChangedSceneId } } }) with the recovery
// exemption already applied by the collector (Section 12.3: an
// object recovered in this scene counts as present for this
// scene's checks). `ctx` carries { project, sceneNumber,
// numberById }. Returns warnings (each with a fingerprint).
function novaCheckObjectContinuity(checkState, scene, sceneId, ctx) {
  const warnings = [];
  const context = ctx || {};
  const project = context.project || null;
  const sceneNumber = context.sceneNumber || null;
  const numberById = context.numberById || {};
  if (!project || !checkState || !checkState.objects) return warnings;
  const text = novaCheckSceneText(scene);
  if (!text) return warnings;
  const sceneLocation =
    scene && typeof scene.location === "string" ? scene.location.trim() : "";
  const movesHere = new Set();
  (scene && Array.isArray(scene.stateChanges) ? scene.stateChanges : []).forEach(
    change => {
      if (change && change.transition === "move" && change.objectId) {
        movesHere.add(change.objectId);
      }
    }
  );

  novaGetProjectObjects(project).forEach(object => {
    if (!novaObjectNameMentioned(object.name, text)) return;
    const state = checkState.objects[object.id];
    if (!state) return;
    const lossSceneId = state.lastChangedSceneId;
    const lossNumber =
      lossSceneId && numberById[lossSceneId]
        ? numberById[lossSceneId]
        : null;
    const lossLabel =
      lossNumber !== null ? "Scene " + lossNumber : "an earlier scene";

    if (state.status === "lost" || state.status === "destroyed") {
      const verb = state.status === "lost" ? "lost" : "destroyed";
      warnings.push(
        novaWarningWithFingerprint({
          key: "object:" + verb + ":" + object.id,
          kind: "object",
          message:
            "Scene " +
            (sceneNumber !== null ? sceneNumber : "?") +
            " mentions the " +
            object.name +
            ", but it was " +
            verb +
            " in " +
            lossLabel +
            (state.status === "lost" ? " and has not been recovered." : "."),
          sceneId,
          sceneNumber,
          severity: "warning",
          stableRef: object.id,
          provenance: lossSceneId || "canon"
        })
      );
      return;
    }

    // Present but elsewhere: an INFO note (Section 15.2). A move
    // declared in this scene IS the explanation (decision D19).
    if (
      state.status === "present" &&
      state.currentLocation &&
      sceneLocation &&
      novaNormalize35b(state.currentLocation) !== novaNormalize35b(sceneLocation) &&
      !movesHere.has(object.id)
    ) {
      warnings.push(
        novaWarningWithFingerprint({
          key: "object:location:" + object.id,
          kind: "object",
          message:
            "The " +
            object.name +
            " is in " +
            state.currentLocation +
            ", but Scene " +
            (sceneNumber !== null ? sceneNumber : "?") +
            " is set in " +
            sceneLocation +
            ".",
          sceneId,
          sceneNumber,
          severity: "info",
          stableRef: object.id,
          provenance: lossSceneId || "canon"
        })
      );
    }
  });
  return warnings;
}

// ---- Appearance checks (Sections 13.4, 13.5) --------------------------

// Descriptive words of an appearance value: tokens minus colour
// words, minus the feature word (and its plural), minus stop
// words. "clean black cloak" -> {clean}; "black cloak, burned at
// the hem, soot-stained" -> {burned, hem, soot, stained}.
function novaAppearanceDescriptiveWords(value, feature) {
  const tokens = novaContinuityTokens(value || "");
  const colors = new Set(NOVA_CONTINUITY_COLORS);
  const words = new Set();
  tokens.forEach(token => {
    if (colors.has(token)) return;
    if (NOVA_STATE_WORD_STOP.has(token)) return;
    if (feature && (token === feature || token === feature + "s")) return;
    if (feature && feature.endsWith("s") && token === feature.slice(0, -1)) return;
    words.add(token);
  });
  return words;
}

// The prompt's description of a feature: descriptive words within
// 4 tokens of the feature word (the 3.4E matcher's window),
// plus the colours attached to it (via the matcher). Returns
// { words: Set, colors: Set, mentioned: boolean }.
// The prompt's description of a feature: the non-colour,
// non-feature words within 4 tokens of the feature word, plus
// the colours the 3.4E matcher attaches to it. `excludeWords`
// (optional, a Set of lowercase words) holds proper names —
// character, object and location names — which are never
// wardrobe descriptors (decision D27); common verbs are
// excluded via NOVA_APPEARANCE_VERB_STOP.
function novaAppearancePromptDescription(promptText, feature, extraFeatures, excludeWords) {
  const tokens = novaContinuityTokens(promptText || "");
  const colors = new Set(NOVA_CONTINUITY_COLORS);
  const words = new Set();
  let mentioned = false;
  const featureForms = new Set();
  if (feature) {
    featureForms.add(feature);
    featureForms.add(feature + "s");
    if (feature.endsWith("s")) featureForms.add(feature.slice(0, -1));
  }
  tokens.forEach((token, i) => {
    if (!featureForms.has(token)) return;
    mentioned = true;
    for (let j = Math.max(0, i - 4); j <= Math.min(tokens.length - 1, i + 4); j++) {
      if (j === i) continue;
      const near = tokens[j];
      if (colors.has(near)) continue;
      if (NOVA_STATE_WORD_STOP.has(near)) continue;
      if (NOVA_APPEARANCE_VERB_STOP.has(near)) continue;
      if (excludeWords && excludeWords.has(near)) continue;
      if (featureForms.has(near)) continue;
      words.add(near);
    }
  });
  // Colours attached to the feature, via the 3.4E matcher.
  const found = novaContinuityFeatureColors(
    promptText || "",
    extraFeatures || []
  );
  const promptColors = new Set();
  found.forEach((colorSet, foundFeature) => {
    if (novaAppearanceCanonicalFeature(foundFeature) ===
        novaAppearanceCanonicalFeature(feature || "")) {
      colorSet.forEach(color => promptColors.add(color));
    }
  });
  return { words, colors: promptColors, mentioned };
}

// Effective-state wardrobe/hair/armour checks with the own-scene
// check set (Sections 13.4, 13.5). `carriedIn` is the appearance
// state carried INTO the scene; `after` is the state after the
// scene's own declarations (both from the chain entry). For each
// field, the check set is { incoming value } ∪ { declared new
// value }; a prompt matching either is consistent; only a
// description matching NEITHER warns. No injury-contradiction
// warnings (Section 13.4). `ctx` carries { characters (the
// resolved presence), sceneNumber, numberById,
// appearanceProvenance }. Returns warnings (each fingerprinted).
function novaCheckAppearanceContinuity(carriedIn, after, scene, sceneId, ctx) {
  const warnings = [];
  const context = ctx || {};
  const characters = Array.isArray(context.characters) ? context.characters : [];
  const sceneNumber = context.sceneNumber || null;
  const numberById = context.numberById || {};
  const provenanceMap = context.appearanceProvenance || {};
  const nameWords = context.nameWords || null;
  const text = novaCheckSceneText(scene);
  if (!text || !characters.length) return warnings;

  const fields = ["wardrobe", "hair", "armour"];
  characters.forEach(character => {
    const incoming = (carriedIn && carriedIn[character.id]) || {};
    const outgoing = (after && after[character.id]) || {};
    const provenance = provenanceMap[character.id] || {};
    fields.forEach(field => {
      const incomingValue = incoming[field] || "";
      const outgoingValue = outgoing[field] || "";
      // The check set: incoming ∪ declared (deduped, non-empty).
      const checkSet = [];
      [incomingValue, outgoingValue].forEach(value => {
        if (value && checkSet.indexOf(value) < 0) checkSet.push(value);
      });
      if (!checkSet.length) return;

      // The feature word for this field, derived from the saved
      // values (the 3.5A derivation: last token, canonicalised).
      let feature = null;
      for (const value of checkSet) {
        const derived = novaAppearancePartFeature(value);
        if (derived) {
          feature = derived;
          break;
        }
      }
      if (field === "hair") feature = "hair";
      if (!feature) return;

      const derivedFeatures = new Set();
      checkSet.forEach(value => {
        const derived = novaAppearancePartFeature(value);
        if (derived) derivedFeatures.add(derived);
      });
      const described = novaAppearancePromptDescription(
        text,
        feature,
        Array.from(derivedFeatures),
        nameWords
      );
      if (!described.mentioned) return;

      const producingSceneId = provenance[field] || null;
      const producingLabel = producingSceneId
        ? novaSceneNumberLabel({ sceneNumberById: numberById }, producingSceneId)
        : "canon";

      // --- Colour contradictions (the 3.4E matcher, upgraded to
      // the check set): the prompt's colour for the feature must
      // appear in at least one check-set value's colours.
      const savedColors = new Set();
      checkSet.forEach(value => {
        const found = novaContinuityFeatureColors(
          value,
          Array.from(derivedFeatures)
        );
        found.forEach((colorSet, foundFeature) => {
          if (
            novaAppearanceCanonicalFeature(foundFeature) ===
            novaAppearanceCanonicalFeature(feature)
          ) {
            colorSet.forEach(color => savedColors.add(color));
          }
        });
      });
      described.colors.forEach(promptColor => {
        if (savedColors.has(promptColor)) return;
        // The key names the incoming value's colour (the state
        // the scene starts from); fall back to the declared one.
        let savedColor = null;
        for (const value of checkSet) {
          const found = novaContinuityFeatureColors(
            value,
            Array.from(derivedFeatures)
          );
          let hit = null;
          found.forEach((colorSet, foundFeature) => {
            if (
              novaAppearanceCanonicalFeature(foundFeature) ===
                novaAppearanceCanonicalFeature(feature) &&
              colorSet.size
            ) {
              hit = Array.from(colorSet)[0];
            }
          });
          if (hit) {
            savedColor = hit;
            break;
          }
        }
        if (!savedColor) return;
        warnings.push(
          novaWarningWithFingerprint({
            key:
              "color:" +
              novaAppearanceCanonicalFeature(feature) +
              ":" +
              savedColor +
              ":" +
              promptColor,
            kind: "appearance",
            message:
              "Prompt describes the " +
              novaAppearanceCanonicalFeature(feature) +
              " as " +
              promptColor +
              ", but the current state (" +
              producingLabel +
              ") says " +
              savedColor +
              ".",
            sceneId,
            sceneNumber,
            severity: "warning",
            stableRef: character.id,
            provenance: producingSceneId || "canon"
          })
        );
      });

      // --- State-word contradictions (decision D3, Rev 5
      // lexicon): every LEXICON word the prompt uses for the
      // feature must appear in at least one check-set value's
      // descriptive words. The lexicon is the DECIDING filter
      // (Section 13.4) — a prompt word not in
      // NOVA_APPEARANCE_STATE_LEXICON is ignored, never a
      // warning, however close to the feature it sits (so
      // "Fire catches Theron's cloak." warns nothing: fire,
      // catches and the possessive "s" are not lexicon words).
      // A prompt with no lexicon words for the feature matches
      // trivially (no contradiction). Matching is literal:
      // "burning" is not "burned".
      const promptStateWords = Array.from(described.words).filter(word =>
        NOVA_APPEARANCE_STATE_LEXICON.has(word)
      );
      if (promptStateWords.length) {
        const checkWords = new Set();
        checkSet.forEach(value => {
          novaAppearanceDescriptiveWords(value, feature).forEach(word => {
            if (NOVA_APPEARANCE_STATE_LEXICON.has(word)) checkWords.add(word);
          });
        });
        const offending = promptStateWords.filter(
          word => !checkWords.has(word)
        );
        if (offending.length) {
          const savedWords = Array.from(
            novaAppearanceDescriptiveWords(incomingValue, feature)
          ).filter(word => NOVA_APPEARANCE_STATE_LEXICON.has(word));
          const savedWord =
            savedWords[0] ||
            Array.from(
              novaAppearanceDescriptiveWords(outgoingValue, feature)
            ).filter(word => NOVA_APPEARANCE_STATE_LEXICON.has(word))[0] ||
            "unchanged";
          warnings.push(
            novaWarningWithFingerprint({
              key:
                "appearance:" +
                field +
                ":" +
                savedWord +
                ":" +
                offending[0],
              kind: "appearance",
              message:
                "Prompt describes " +
                character.name +
                "'s " +
                field +
                " as " +
                offending[0] +
                ", but the current state (" +
                producingLabel +
                ") says " +
                (incomingValue || outgoingValue) +
                ".",
              sceneId,
              sceneNumber,
              severity: "warning",
              stableRef: character.id,
              provenance: producingSceneId || "canon"
            })
          );
        }
      }

      // --- Hair length (the 3.5A lexicon, upgraded to the check
      // set): the prompt's hair length must match at least one
      // check-set value's length.
      if (field === "hair") {
        const promptLength = novaHairLengthNearHair(text);
        if (promptLength) {
          const savedLengths = checkSet
            .map(value => novaHairLengthNearHair(value))
            .filter(Boolean);
          if (
            savedLengths.length &&
            savedLengths.indexOf(promptLength) < 0
          ) {
            warnings.push(
              novaWarningWithFingerprint({
                key:
                  "length:hair:" +
                  (novaHairLengthNearHair(incomingValue) ||
                    savedLengths[0]) +
                  ":" +
                  promptLength,
                kind: "appearance",
                message:
                  "Prompt describes the hair as " +
                  promptLength +
                  ", but the current state (" +
                  producingLabel +
                  ") says " +
                  (novaHairLengthNearHair(incomingValue) || savedLengths[0]) +
                  ".",
                sceneId,
                sceneNumber,
                severity: "warning",
                stableRef: character.id,
                provenance: producingSceneId || "canon"
              })
            );
          }
        }
      }
    });
  });
  return warnings;
}

// ---- Location checks (Section 14) -------------------------------------

// Location-transition info notes. `prevLocation` is the previous
// scene's location (string or null). `ctx` carries { sceneNumber,
// numberById, prevSceneId, prevSceneNumber }. A scene that changes
// location without a transition marker produces an INFO-level note
// naming both scenes, not a warning. Returns warnings (each
// fingerprinted) — zero or one.
function novaCheckLocationContinuity(prevLocation, scene, sceneId, ctx) {
  const context = ctx || {};
  const sceneNumber = context.sceneNumber || null;
  const prevSceneNumber = context.prevSceneNumber || null;
  const prevSceneId = context.prevSceneId || null;
  const sceneLocation =
    scene && typeof scene.location === "string" ? scene.location.trim() : "";
  if (!sceneLocation || !prevLocation) return [];
  if (
    novaNormalize35b(sceneLocation) === novaNormalize35b(prevLocation)
  ) {
    return [];
  }
  const text = novaCheckSceneText(scene);
  if (novaLocationMarkersPresent(text)) return [];
  return [
    novaWarningWithFingerprint({
      key: "location:transition",
      kind: "location",
      message:
        "Scene " +
        (sceneNumber !== null ? sceneNumber : "?") +
        " moves from " +
        prevLocation +
        " to " +
        sceneLocation +
        " without a transition marker (Scene " +
        (prevSceneNumber !== null ? prevSceneNumber : "?") +
        " was in " +
        prevLocation +
        ").",
      sceneId,
      sceneNumber,
      severity: "info",
      stableRef: null,
      provenance: prevSceneId || "canon"
    })
  ];
}

// ---- The warning collector (Section 15.1) ----------------------------

// Collects every warning for a plan, in one place, in a fixed
// order: the 3.4E-family checks first (colour, eye count, era),
// then the 3.5B effective-state checks (objects, appearance,
// locations), then the style checks once for the whole plan.
// Warnings are deduplicated by (sceneId, key) — first occurrence
// wins — so the same fact, reported against canon AND against
// effective state, is shown once (Section 15.3).
// Returns { warnings, suppressed, skipped, error }. `warnings`
// are the visible ones (no matching live decision or dismissal);
// `suppressed` are the ones a live decision or dismissal hides
// (each carries `suppressedBy: "decision"` or "dismissal").
// `skipped` names the scenes the style check skipped (custom
// override). On a chain or presence error the collector returns
// { error } (the build is blocked; no warnings are shown).
// The collector is PURE with respect to the plan: it never writes
// decisions, never bumps a version, never touches storage.
function novaCollectPlanWarnings(project, plan) {
  const failure = error => ({
    warnings: [],
    suppressed: [],
    skipped: [],
    error,
    chain: null
  });
  if (!project || !plan || !Array.isArray(plan.scenes)) {
    return failure("No project or plan was supplied for the checks.");
  }

  // The chain is the single source of effective state. A chain
  // error blocks the build (Section 14) — no warnings are
  // collected against a broken chain.
  const chain = novaBuildProductionState(project, plan);
  if (chain.error) return failure(chain.error);

  const decisions = Array.isArray(plan.continuityDecisions)
    ? plan.continuityDecisions
    : [];
  const dismissed = novaDismissedWarningFingerprints;

  const collected = [];
  const seen = new Set();

  // Proper names, once per collection (decision D27): every
  // word of every project character, object and location name,
  // lowercased. The appearance check excludes them from the
  // prompt's descriptive words — a name next to a garment word
  // ("Jonah wear red cloaks") is not a wardrobe descriptor.
  const nameWords = new Set();
  (Array.isArray(project.characterIds) ? project.characterIds : []).forEach(id => {
    const character = novaGetCharacter(id);
    if (character && character.name) {
      novaNormalize35b(character.name).split(" ").forEach(word => {
        if (word) nameWords.add(word);
      });
    }
  });
  novaGetProjectObjects(project).forEach(object => {
    if (object && object.name) {
      novaNormalize35b(object.name).split(" ").forEach(word => {
        if (word) nameWords.add(word);
      });
    }
  });
  novaGetProjectLocations(project).forEach(location => {
    if (location && location.name) {
      novaNormalize35b(location.name).split(" ").forEach(word => {
        if (word) nameWords.add(word);
      });
    }
  });
  const push = warning => {
    // Dedupe by scene + key + stableRef: two characters with
    // the same colour key in the same scene are two distinct
    // warnings (B15 — the fingerprint carries the characterId
    // via stableRef), while the 3.5B effective-state warning
    // and the 3.4E canon warning for the SAME character still
    // collapse to one (same stableRef, first wins).
    const dedupeKey =
      warning.sceneId + "|" + warning.key + "|" + (warning.stableRef || "");
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    collected.push(warning);
  };

  // The style checks run once for the whole plan (3.5A behaviour,
  // unchanged) — but their warnings are collected AFTER the
  // per-scene checks, so the per-scene order below is preserved.
  // (They are computed first only so the `skipped` list is known
  // before the loop; their warnings join the collection at the
  // end.)
  const styleResult = novaCollectStyleWarnings(plan, project);
  const styleWarnings = Array.isArray(styleResult)
    ? styleResult
    : styleResult.warnings || [];
  // `skipped` holds SCENE NUMBERS (the 3.5A collector's shape),
  // not sceneIds.
  const styleSkipped = Array.isArray(styleResult)
    ? []
    : styleResult.skipped || [];

  for (let index = 0; index < plan.scenes.length; index++) {
    const scene = plan.scenes[index];
    const entry = chain.scenes[index];
    const sceneNumber = index + 1;

    // Presence (3.5A): who is in this scene? A presence error
    // (an unknown character id in the scene's characters list)
    // blocks the build. novaSceneCharacters returns
    // { characters, error } — it does not throw.
    const presence = novaSceneCharacters(project, plan, scene);
    if (presence.error) {
      return failure(
        "Scene " + sceneNumber + ": " + presence.error
      );
    }
    const characters = presence.characters;

    // --- Object checks (against the carried-in state, with the
    // recovery exemption: an object recovered in this scene
    // counts as present for this scene's checks, Section 12.3).
    const checkObjects = novaDeepCopy35b(entry.carriedIn.objects);
    (scene.stateChanges || []).forEach(change => {
      if (change && change.transition === "recover" && change.objectId) {
        if (checkObjects[change.objectId]) {
          checkObjects[change.objectId].status = "present";
        }
      }
    });
    novaCheckObjectContinuity(
      { objects: checkObjects },
      scene,
      scene.id,
      { project, sceneNumber, numberById: chain.sceneNumberById }
    ).forEach(push);

    // --- Appearance checks (own-scene check set, Section 13.5).
    novaCheckAppearanceContinuity(
      entry.carriedIn.appearance,
      entry.appearance,
      scene,
      scene.id,
      {
        characters,
        sceneNumber,
        numberById: chain.sceneNumberById,
        appearanceProvenance: entry.carriedIn.appearanceProvenance,
        nameWords
      }
    ).forEach(push);

    // --- Location check (against the previous scene's location).
    const prevEntry = index > 0 ? chain.scenes[index - 1] : null;
    novaCheckLocationContinuity(
      prevEntry ? prevEntry.location : null,
      scene,
      scene.id,
      {
        sceneNumber,
        numberById: chain.sceneNumberById,
        prevSceneId: prevEntry ? prevEntry.sceneId : null,
        prevSceneNumber: index > 0 ? index : null
      }
    ).forEach(push);

    // --- 3.4E-family checks per present character (canon, via
    // the frozen 3.4E functions). The check text is the scene's
    // title + direction (decision D22), so a warning about the
    // scene's own description is never raised against the
    // system's injected identity lines.
    characters.forEach(character => {
      const built = novaBuildContinuityContext(project.id, character.id);
      if (built.error) return; // The chain already validated the cast.
      const conflicts = novaCheckContinuityConflicts(
        built.context,
        novaCheckSceneText(scene)
      );
      conflicts.forEach(conflict => {
        push(
          novaWarningWithFingerprint({
            key: conflict.key,
            kind: conflict.kind || "continuity",
            message: conflict.message,
            sceneId: scene.id,
            sceneNumber,
            severity: conflict.severity || "warning",
            stableRef: character.id,
            provenance: "canon"
          })
        );
      });
    });
  }

  // --- Style warnings (3.5A, once for the plan). The 3.5A
  // warnings carry only { key, message, sceneNumber } — the
  // sceneId is attached here from the scene number, and the
  // 3.5B fields (kind, severity, stableRef, provenance) are
  // defaulted (style warnings are canon-provenance).
  styleWarnings.forEach(warning => {
    const number =
      typeof warning.sceneNumber === "number" ? warning.sceneNumber : null;
    const scene =
      number !== null && plan.scenes[number - 1]
        ? plan.scenes[number - 1]
        : null;
    if (!scene) return;
    push(
      novaWarningWithFingerprint({
        key: warning.key,
        kind: "style",
        message: warning.message,
        sceneId: scene.id,
        sceneNumber: number,
        severity: "warning",
        stableRef: null,
        provenance: "canon"
      })
    );
  });

  // --- Suppression, by LIVE matching only: a decision or a
  // dismissal hides a warning only while its key + sceneId +
  // fingerprint all match a current warning. The watermark is
  // never consulted here (decision D2's corollary).
  const visible = [];
  const suppressed = [];
  collected.forEach(warning => {
    const decision = decisions.find(
      d =>
        d &&
        d.key === warning.key &&
        d.sceneId === warning.sceneId &&
        d.fingerprint === warning.fingerprint
    );
    if (decision) {
      suppressed.push({ ...warning, suppressedBy: "decision", decision });
      return;
    }
    if (dismissed.has(warning.fingerprint)) {
      suppressed.push({ ...warning, suppressedBy: "dismissal" });
      return;
    }
    visible.push(warning);
  });

  return {
    warnings: visible,
    suppressed,
    skipped: styleSkipped,
    error: null,
    // The chain is returned so the caller (job creation) can
    // reuse it for the snapshot instead of building it twice.
    chain
  };
}

// The warnings for one scene (visible ones only).
function novaPlanWarningsByScene(project, plan) {
  const result = novaCollectPlanWarnings(project, plan);
  const byScene = {};
  if (result.error) return byScene;
  result.warnings.forEach(warning => {
    if (!byScene[warning.sceneId]) byScene[warning.sceneId] = [];
    byScene[warning.sceneId].push(warning);
  });
  return byScene;
}

// ---- Dismissals (Section 16.1) ----------------------------------------

// A dismissal hides a warning for this browser session only
// (module state — it never reaches storage or the snapshot).
// Dismissals are keyed by fingerprint: if the underlying fact
// changes, the fingerprint changes and the warning re-appears.
function novaDismissWarning(warning) {
  if (!warning || !warning.fingerprint) return;
  novaDismissedWarningFingerprints.add(warning.fingerprint);
}

function novaIsWarningDismissed(warning) {
  if (!warning || !warning.fingerprint) return false;
  return novaDismissedWarningFingerprints.has(warning.fingerprint);
}

// ---- Decisions (Section 16.2) -----------------------------------------

// Records a decision ("this warning is intentional") on a plan.
// The decision IS the save (Section 16.2): marking bumps
// plan.version by 1 (decision D2), records the decision under
// the NEW version + the current canon version, and updates
// decisionsCheckedAt to the new versions (the decision was just
// validated against the current warnings; the bump changes no
// warning-relevant fact). The decision records the warning's
// message for display only — the message is NEVER the source of
// truth (key + sceneId + fingerprint are). Re-marking an already
// decided warning replaces the decision (same version bump).
// `warning` is the CURRENT warning object (it carries the
// fingerprint); `project` supplies the canon version.
function novaMarkWarningIntended(plan, warning, reason, project) {
  if (!plan || typeof plan !== "object") {
    return { error: "No plan was supplied for the decision." };
  }
  if (!warning || !warning.key || !warning.sceneId || !warning.fingerprint) {
    return { error: "No warning was supplied for the decision." };
  }
  if (!project || typeof project !== "object") {
    return { error: "No project was supplied for the decision." };
  }
  const currentVersion =
    typeof plan.version === "number" && plan.version >= 1 ? plan.version : 1;
  const canonVersion = novaGetProjectCanonVersion(project);
  const newVersion = currentVersion + 1;
  plan.version = newVersion;
  if (!Array.isArray(plan.continuityDecisions)) plan.continuityDecisions = [];
  const decision = {
    key: warning.key,
    fingerprint: warning.fingerprint,
    sceneId: warning.sceneId,
    reason: typeof reason === "string" ? reason : "",
    planVersion: newVersion,
    canonVersion,
    warningMessage: warning.message || "",
    decidedAt: new Date().toISOString()
  };
  const at = plan.continuityDecisions.findIndex(
    d => d && d.key === warning.key && d.sceneId === warning.sceneId
  );
  if (at >= 0) {
    plan.continuityDecisions[at] = decision;
  } else {
    plan.continuityDecisions.push(decision);
  }
  plan.decisionsCheckedAt = {
    planVersion: newVersion,
    canonVersion
  };
  return { error: null, decision };
}

// Removes the decisions for one scene (used by scene deletion).
function novaRemoveSceneDecisions(plan, sceneId) {
  if (!plan || !Array.isArray(plan.continuityDecisions)) return 0;
  const before = plan.continuityDecisions.length;
  plan.continuityDecisions = plan.continuityDecisions.filter(
    d => !d || d.sceneId !== sceneId
  );
  return before - plan.continuityDecisions.length;
}

// ---- Revalidation (Section 16.2) --------------------------------------

// Revalidates a plan's decisions against the CURRENT warnings.
// A decision stands only while key + sceneId + fingerprint all
// match a current warning. Same key + sceneId but a different
// fingerprint = the underlying fact changed (invalidated). No
// warning with that key + sceneId = the warning vanished. Both
// kinds are REMOVED (a decision is only meaningful while its
// warning exists). The watermark is updated to the current
// versions. Returns { kept, removed, report } where `removed`
// carries both messages ("the decision said X; the warning now
// says Y") for the review panel. `warningsByScene` is the
// collector's visible warnings keyed by sceneId (the collector
// must have run BEFORE this call — the caller supplies it).
//
// Optional fourth argument `options` (Rev 5, trigger 4 —
// accepted scene-text edit):
//   { sceneId } — revalidate ONLY that scene's decisions;
//     every other decision is kept untouched, unevaluated.
//   { updateWatermark: false } — leave decisionsCheckedAt
//     alone. The watermark tracks VERSIONS only; a scene-text
//     edit changes no version, and updating the watermark here
//     would wrongly imply all decisions were revalidated when
//     only one scene was. Defaults: whole plan, watermark
//     updated (triggers 1-3).
function novaRevalidateDecisions(plan, project, warningsByScene, options) {
  const empty = { kept: [], removed: [], report: null };
  if (!plan || !project) return empty;
  const onlySceneId =
    options && typeof options.sceneId === "string" && options.sceneId
      ? options.sceneId
      : null;
  const updateWatermark = !options || options.updateWatermark !== false;
  if (!Array.isArray(plan.continuityDecisions)) {
    plan.continuityDecisions = [];
  }
  const canonVersion = novaGetProjectCanonVersion(project);
  const planVersion =
    typeof plan.version === "number" && plan.version >= 1 ? plan.version : 1;

  // Index the current warnings by (sceneId, key) -> warning.
  const current = new Map();
  Object.keys(warningsByScene || {}).forEach(sceneId => {
    (warningsByScene[sceneId] || []).forEach(warning => {
      current.set(sceneId + "|" + warning.key, warning);
    });
  });
  // Also index the SUPPRESSED warnings: a decision's own warning
  // is in the suppressed list (it is suppressed BY the decision).
  // The caller passes the visible map; the revalidation must
  // also see the suppressed ones or it would remove every live
  // decision. The collector's full result is the honest source —
  // so the caller passes the MERGED map (visible + suppressed).
  // (novaLazyRevalidatePlan and novaRevalidatePlanForCreation
  // both merge before calling.)

  const kept = [];
  const removed = [];
  plan.continuityDecisions.forEach(decision => {
    if (!decision || typeof decision !== "object") return;
    // Trigger 4: a scene-text edit cannot change another
    // scene's warnings, so decisions for other scenes are kept
    // without evaluation.
    if (onlySceneId && decision.sceneId !== onlySceneId) {
      kept.push(decision);
      return;
    }
    const warning = current.get(decision.sceneId + "|" + decision.key);
    if (!warning) {
      removed.push({
        decision,
        reason: "vanished",
        message:
          "The warning for " +
          decision.key +
          " no longer exists, so the decision was removed."
      });
      return;
    }
    if (warning.fingerprint !== decision.fingerprint) {
      removed.push({
        decision,
        reason: "changed",
        message:
          "The underlying fact changed — the decision said \"" +
          (decision.warningMessage || "") +
          "\", the warning now says \"" +
          (warning.message || "") +
          "\" — so the decision was removed."
      });
      return;
    }
    kept.push(decision);
  });

  plan.continuityDecisions = kept;
  if (updateWatermark) {
    plan.decisionsCheckedAt = { planVersion, canonVersion };
  }

  const report =
    removed.length > 0
      ? {
          removed: removed.length,
          message:
            removed.length +
            " continuity decision" +
            (removed.length === 1 ? "" : "s") +
            " " +
            (removed.length === 1 ? "was" : "were") +
            " removed because the underlying facts changed."
        }
      : null;
  return { kept, removed, report };
}

// Merges the collector's visible + suppressed warnings into one
// map keyed by sceneId (the revalidation input).
function novaMergeWarningsByScene(result) {
  const byScene = {};
  if (!result || result.error) return byScene;
  [...(result.warnings || []), ...(result.suppressed || [])].forEach(
    warning => {
      if (!byScene[warning.sceneId]) byScene[warning.sceneId] = [];
      byScene[warning.sceneId].push(warning);
    }
  );
  return byScene;
}

// Lazy revalidation (trigger 1): compares the plan's
// decisionsCheckedAt watermark with the current versions and
// revalidates ONLY if either moved. Returns { revalidated,
// revalidation } where `revalidation` is the novaRevalidateDecisions
// result (null when nothing was revalidated). The collector runs
// only when a revalidation is owed.
function novaLazyRevalidatePlan(project, plan) {
  if (!project || !plan) {
    return { revalidated: false, revalidation: null };
  }
  const watermark = plan.decisionsCheckedAt || null;
  const canonVersion = novaGetProjectCanonVersion(project);
  const planVersion =
    typeof plan.version === "number" && plan.version >= 1 ? plan.version : 1;
  const stale =
    !watermark ||
    watermark.planVersion !== planVersion ||
    watermark.canonVersion !== canonVersion;
  if (!stale) return { revalidated: false, revalidation: null };

  const result = novaCollectPlanWarnings(project, plan);
  if (result.error) {
    // A broken chain blocks the build; the watermark is left
    // stale (the revalidation is owed again once the plan is
    // repaired) and the error is reported, not hidden.
    return {
      revalidated: false,
      revalidation: null,
      error: result.error
    };
  }
  const revalidation = novaRevalidateDecisions(
    plan,
    project,
    novaMergeWarningsByScene(result)
  );
  return { revalidated: true, revalidation };
}

// Explicit refresh (trigger 2): re-runs all checks + revalidates
// all decisions REGARDLESS of the watermark. Returns
// { result, revalidation }.
function novaRefreshContinuity(project, plan) {
  if (!project || !plan) {
    return {
      result: { warnings: [], suppressed: [], skipped: [], error: "No plan." },
      revalidation: null
    };
  }
  const result = novaCollectPlanWarnings(project, plan);
  if (result.error) {
    return { result, revalidation: null };
  }
  const revalidation = novaRevalidateDecisions(
    plan,
    project,
    novaMergeWarningsByScene(result)
  );
  return { result, revalidation };
}

// Pre-creation revalidation (trigger 3): revalidates BEFORE the
// snapshot is taken, so the snapshot always carries
// POST-revalidation decisions (Section 16.2: "A stale decision
// can never suppress a warning in a created job."). Returns
// { result, revalidation, error }.
function novaRevalidatePlanForCreation(project, plan) {
  if (!project || !plan) {
    return {
      result: null,
      revalidation: null,
      error: "No project or plan was supplied."
    };
  }
  const result = novaCollectPlanWarnings(project, plan);
  if (result.error) {
    return { result, revalidation: null, error: result.error };
  }
  const revalidation = novaRevalidateDecisions(
    plan,
    project,
    novaMergeWarningsByScene(result)
  );
  return { result, revalidation, error: null };
}

// Accepted scene-text edit revalidation (trigger 4, Rev 5):
// when a scene-text edit is ACCEPTED (committed — the field
// saved or applied: blur, Enter, Apply, or editor save), the
// edited scene's checks are re-run and that scene's decisions
// revalidated immediately, synchronously, under the same
// fingerprint rules as the other triggers (warning gone ->
// decision REMOVED; fingerprint changed -> INVALIDATED;
// unchanged -> stands). ONLY the edited scene is revalidated:
// a scene-text edit cannot change another scene's warnings, so
// other scenes' decisions are kept untouched. NO plan.version
// increment (scene-text edits are not versioned changes) and
// NO watermark update (the watermark tracks versions only,
// which the edit does not change).
//
// Transient typing triggers nothing: this function runs only
// when the caller invokes it at the commit point. The caller
// is novaSaveSceneText — the Save button of the per-scene
// scene-text editor in the state controls
// (novaSceneStateControlHtml). Scenes are built from beats by
// buildMotionPlan, but their title and direction are editable
// there; saving is the accepted-edit event this function
// serves.
//
// The collector has no per-scene entry point — and a scene's
// checks depend on the chain state carried in from earlier
// scenes — so the plan collector runs and the revalidation is
// scoped to the edited scene's decisions. Returns
// { revalidated, revalidation, error } (the trigger-1 shape).
function novaRevalidateSceneAfterAcceptedEdit(project, plan, sceneId) {
  if (!project || !plan) {
    return {
      revalidated: false,
      revalidation: null,
      error: "No project or plan was supplied."
    };
  }
  if (
    typeof sceneId !== "string" ||
    !sceneId ||
    !Array.isArray(plan.scenes) ||
    !plan.scenes.some(s => s && s.id === sceneId)
  ) {
    return {
      revalidated: false,
      revalidation: null,
      error: "No scene with that id in this plan."
    };
  }
  const result = novaCollectPlanWarnings(project, plan);
  if (result.error) {
    // A broken chain blocks the build; the decisions are left
    // exactly as they were and the error is reported, not
    // hidden.
    return {
      revalidated: false,
      revalidation: null,
      error: result.error
    };
  }
  const revalidation = novaRevalidateDecisions(
    plan,
    project,
    novaMergeWarningsByScene(result),
    { sceneId, updateWatermark: false }
  );
  return { revalidated: true, revalidation };
}

// Pre-creation check, for the UI: runs the trigger-3
// revalidation and returns the plain-language removals message
// (or null when nothing was removed). The caller shows the
// message and asks the user to confirm before creating.
function novaPreCreateContinuityCheck(project, plan) {
  const checked = novaRevalidatePlanForCreation(project, plan);
  if (checked.error) {
    return { error: checked.error, message: null, removed: 0 };
  }
  const removed = checked.revalidation
    ? checked.revalidation.removed.length
    : 0;
  if (!removed) return { error: null, message: null, removed: 0 };
  return {
    error: null,
    message:
      removed +
      " continuity decision" +
      (removed === 1 ? "" : "s") +
      (removed === 1 ? " was" : " were") +
      " removed because the underlying facts changed — review the warnings before creating.",
    removed
  };
}

// ---- The immutable production snapshot (Section 17) -------------------

// Builds job.productionContinuity: the full production state at
// the moment of creation, frozen alongside the existing
// continuitySnapshot (3.4B) and continuityContext (3.4E). The
// snapshot is built from the POST-revalidation plan (the caller
// revalidates first — novaCreateProjectJob does). It is a plain
// data object: every nested value is a deep copy, so later edits
// to the project or plan cannot mutate it. `chain` is the
// novaBuildProductionState result for the plan (built by the
// caller so the chain is built once, not twice).
function novaBuildProductionContinuitySnapshot(project, plan, chain) {
  const snapshot = {
    planVersion:
      typeof plan.version === "number" && plan.version >= 1 ? plan.version : 1,
    canonVersion: novaGetProjectCanonVersion(project),
    characterRecords: [],
    appearanceState: {},
    referenceImageIds: {},
    projectVisualStyle: plan.styleBasis || null,
    projectStyleAtCreation: novaDeepCopy35b(
      novaGetProjectVisualStyle(project)
    ),
    sceneStyleOverrides: [],
    objects: novaDeepCopy35b(novaGetProjectObjects(project)),
    locations: novaDeepCopy35b(novaGetProjectLocations(project)),
    stateTransitions: [],
    productionState: [],
    continuityDecisions: novaDeepCopy35b(plan.continuityDecisions || []),
    effectiveSceneContexts: []
  };

  const cast = Array.isArray(plan.cast) ? plan.cast : [];
  cast.forEach(characterId => {
    const character = novaGetCharacter(characterId);
    if (!character) return;
    const appearance = character.appearance || {};
    snapshot.characterRecords.push({
      id: character.id,
      name: character.name || "",
      version:
        typeof character.version === "number" ? character.version : 1,
      species: typeof appearance.species === "string" ? appearance.species : "",
      colors: novaDeepCopy35b(appearance.colors || {}),
      distinctiveFeatures: novaDeepCopy35b(appearance.distinctiveFeatures || []),
      permanentDetails:
        typeof appearance.permanentDetails === "string"
          ? appearance.permanentDetails
          : "",
      wardrobe: typeof appearance.wardrobe === "string" ? appearance.wardrobe : "",
      hair: typeof appearance.hair === "string" ? appearance.hair : "",
      accessories: novaDeepCopy35b(appearance.accessories || []),
      imageAssetId: character.imageAssetId || null
    });
    snapshot.referenceImageIds[characterId] = character.imageAssetId || null;
  });

  // The FINAL appearance state (after the last scene).
  const finalEntry =
    chain && Array.isArray(chain.scenes) && chain.scenes.length
      ? chain.scenes[chain.scenes.length - 1]
      : null;
  snapshot.appearanceState = finalEntry
    ? novaDeepCopy35b(finalEntry.appearance)
    : {};

  plan.scenes.forEach((scene, index) => {
    const entry =
      chain && Array.isArray(chain.scenes) ? chain.scenes[index] : null;
    const override = plan.sceneStyleOverrides
      ? plan.sceneStyleOverrides[scene.id]
      : null;
    if (override) {
      snapshot.sceneStyleOverrides.push({
        sceneId: scene.id,
        preset: override.preset || null,
        // The custom direction is stored VERBATIM (Section 17) —
        // it is the exact text injected into the scene prompt.
        customDirection:
          typeof override.customDirection === "string"
            ? override.customDirection
            : "",
        reason: typeof override.reason === "string" ? override.reason : ""
      });
    }
    snapshot.stateTransitions.push({
      sceneId: scene.id,
      objectChanges: novaDeepCopy35b(scene.stateChanges || []),
      characterChanges: novaDeepCopy35b(scene.characterStateChanges || [])
    });
    if (entry) {
      // The snapshot stores only the Section 14 shape
      // { location, objects, appearance } — the chain's internal
      // fields (carriedIn, provenance, transitions) are NOT
      // snapshot data.
      snapshot.productionState.push({
        sceneId: scene.id,
        state: {
          location: entry.location,
          objects: novaDeepCopy35b(entry.objects),
          appearance: novaDeepCopy35b(entry.appearance)
        }
      });
    }

    // The EXACT text injected per scene, built with the same
    // functions the plan uses (Section 17) — so the snapshot and
    // the prompts agree by construction (B10). Presence was
    // already validated by the collector (the caller revalidates
    // before snapshotting); a defensive empty fallback covers a
    // direct call with a broken plan.
    const presence = novaSceneCharacters(project, plan, scene);
    const characters = presence.error ? [] : presence.characters;
    const castLines = characters.length
      ? novaBuildCastLines(project, characters, index + 1)
      : { lines: [], error: null };
    const identityLines = castLines.error ? [] : castLines.lines;
    const stateLine = entry
      ? novaContinuityStateLine(chain, scene, index)
      : "";
    const style = novaEffectiveSceneStyle(plan, project, scene);
    snapshot.effectiveSceneContexts.push({
      sceneId: scene.id,
      charactersPresent: characters.map(character => character.id),
      identityLines: identityLines.join("\n"),
      stateLine,
      styleFragment: novaVisualStyleFragment(style.preset, style.customDirection)
    });
  });

  return snapshot;
}

// ---- The production continuity review panel (Section 16.3) ------------

// The full production continuity section for the review panel:
// warnings grouped by scene, each with its mark-as-intended form
// (reason + Mark intentional), the dismissed-decisions report at
// the top when a revalidation removed decisions, and the
// "Refresh continuity" button. When `warnings` is not passed in,
// the review runs the lazy revalidation (trigger 1) first — the
// review render IS the plan-open in this UI (decision D21) — and
// renders any revalidation report at the top. When warnings are
// passed in (tests), no revalidation runs (the caller owns it).
// Returns an HTML string (all user text escaped).
function novaProductionContinuityReviewHtml(project, plan, warnings) {
  if (!project || !plan) return "";
  let collected = null;
  let revalidationReport = null;
  if (Array.isArray(warnings)) {
    collected = { warnings, suppressed: [], skipped: [], error: null };
  } else {
    const lazy = novaLazyRevalidatePlan(project, plan);
    if (lazy.error) {
      return (
        '<div class="nova-prod-continuity">' +
        '<h3>Production continuity</h3>' +
        '<p class="nova-continuity-error">' +
        novaEscape(lazy.error) +
        "</p></div>"
      );
    }
    if (lazy.revalidation && lazy.revalidation.report) {
      revalidationReport = lazy.revalidation.report;
    }
    collected = novaCollectPlanWarnings(project, plan);
    if (collected.error) {
      return (
        '<div class="nova-prod-continuity">' +
        '<h3>Production continuity</h3>' +
        '<p class="nova-continuity-error">' +
        novaEscape(collected.error) +
        "</p></div>"
      );
    }
  }

  const byScene = {};
  collected.warnings.forEach(warning => {
    if (!byScene[warning.sceneId]) byScene[warning.sceneId] = [];
    byScene[warning.sceneId].push(warning);
  });

  let html = '<div class="nova-prod-continuity">';
  html += "<h3>Production continuity</h3>";
  if (revalidationReport) {
    html +=
      '<p class="nova-continuity-notice">' +
      novaEscape(revalidationReport.message) +
      "</p>";
  }
  if (!collected.warnings.length) {
    html +=
      "<p>No continuity warnings — the plan is consistent with the project canon.</p>";
  } else {
    plan.scenes.forEach((scene, index) => {
      const sceneWarnings = byScene[scene.id] || [];
      if (!sceneWarnings.length) return;
      html +=
        '<div class="nova-prod-scene-group"><h4>' +
        novaEscape("Scene " + (index + 1) + ": " + (scene.title || "")) +
        "</h4>";
      sceneWarnings.forEach(warning => {
        html += novaProductionWarningHtml(project, plan, warning);
      });
      html += "</div>";
    });
  }
  if (collected.skipped && collected.skipped.length) {
    // `skipped` holds scene NUMBERS (the 3.5A collector's shape).
    html +=
      '<p class="nova-continuity-note">Style checks skipped for scenes with a custom override: ' +
      collected.skipped
        .map(n => "Scene " + n)
        .map(novaEscape)
        .join(", ") +
      ".</p>";
  }
  html +=
    '<button type="button" class="ws-btn" data-nova-click="novaRefreshContinuityUi">Refresh continuity</button>';
  html += "</div>";
  return html;
}

// One warning row: the message, its severity, and the
// mark-as-intended form (reason + button). The form carries the
// warning's key + sceneId; the handler re-resolves the CURRENT
// warning (by key + sceneId) so the decision records the current
// fingerprint, never a stale one.
function novaProductionWarningHtml(project, plan, warning) {
  const severity =
    warning.severity === "info" ? "info" : "warning";
  const formId =
    "nova-mark-" + warning.sceneId + "-" + novaNormalize35b(warning.key);
  let html =
    '<div class="nova-prod-warning nova-prod-warning-' +
    severity +
    '"><p class="nova-prod-warning-message">' +
    novaEscape(warning.message) +
    "</p>";
  html +=
    '<form class="nova-mark-intended-form" data-scene-id="' +
    novaEscape(warning.sceneId) +
    '" data-warning-key="' +
    novaEscape(warning.key) +
    '" data-nova-submit="novaMarkIntendedSubmit">' +
    '<label for="' +
    novaEscape(formId) +
    '">Why is this intentional?</label> ' +
    '<input id="' +
    novaEscape(formId) +
    '" name="reason" type="text" placeholder="e.g. the cloak is burned in the next scene" required> ' +
    '<button type="submit" class="ws-btn">Mark intentional</button>' +
    "</form></div>";
  return html;
}

// The mark-as-intended form handler: re-resolves the CURRENT
// warning by key + sceneId (the decision records the CURRENT
// fingerprint), marks it, and re-renders the review.
function novaMarkIntendedSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const sceneId = form.getAttribute("data-scene-id");
  const key = form.getAttribute("data-warning-key");
  const reason = form.reason ? form.reason.value : "";
  const plan = novaMotionPlan;
  const project = novaSelectedProjectId
    ? novaGetProject(novaSelectedProjectId)
    : null;
  if (!plan || !project) return false;
  const collected = novaCollectPlanWarnings(project, plan);
  if (collected.error) {
    alert(collected.error);
    return false;
  }
  const warning = [...collected.warnings, ...collected.suppressed].find(
    w => w.sceneId === sceneId && w.key === key
  );
  if (!warning) {
    alert("That warning no longer exists — the plan has changed.");
    novaRenderProductionIdentity();
    return false;
  }
  const marked = novaMarkWarningIntended(plan, warning, reason, project);
  if (marked.error) {
    alert(marked.error);
    return false;
  }
  novaRenderProductionIdentity();
  return false;
}

// The "Refresh continuity" button handler (trigger 2): re-runs
// all checks + revalidates all decisions regardless of the
// watermark, then re-renders the review.
function novaRefreshContinuityUi() {
  const plan = novaMotionPlan;
  const project = novaSelectedProjectId
    ? novaGetProject(novaSelectedProjectId)
    : null;
  if (!plan || !project) return;
  const refreshed = novaRefreshContinuity(project, plan);
  if (refreshed.result && refreshed.result.error) {
    alert(refreshed.result.error);
    return;
  }
  if (refreshed.revalidation && refreshed.revalidation.report) {
    novaLastRevalidationReport = refreshed.revalidation.report;
  }
  novaRenderProductionIdentity();
}

// ---- Workspace: Objects & Locations (Section 12.1) --------------------

// The Objects & Locations section for the project detail view.
// Objects are id-keyed (names may duplicate); locations are
// name-keyed (duplicate names are refused). Both lists live on
// project.continuity.{objects, locations} and are saved through
// novaUpdateProject (which bumps the canon version — objects and
// locations are in the bump set, decision D6).
function novaWorkspaceObjectsSectionHtml(project) {
  if (!project) return "";
  const objects = novaGetProjectObjects(project);
  const locations = novaGetProjectLocations(project);
  const characters = novaLoadCharacters().filter(
    character => character.projectId === project.id
  );
  const editingObject = novaWorkspaceEditingObjectId
    ? objects.find(o => o.id === novaWorkspaceEditingObjectId) || null
    : null;
  const editingLocation = novaWorkspaceEditingLocationName
    ? locations.find(l => l.name === novaWorkspaceEditingLocationName) || null
    : null;

  let html = `<h2>📦 Objects &amp; Locations</h2>`;
  html += `<p class="motion-note">Objects and places the story tracks across scenes. Objects carry a state (present, lost, damaged, destroyed) that scenes change; locations are the places scenes can be set.</p>`;

  // --- Objects ---
  html += `<h3>Objects</h3>`;
  if (!objects.length) {
    html += `<p class="motion-note">No objects yet. Add the first object this project tracks.</p>`;
  } else {
    html += `<div class="ws-grid">`;
    objects.forEach(object => {
      const owner = object.ownerCharacterId
        ? novaGetCharacter(object.ownerCharacterId)
        : null;
      const confirming =
        novaWorkspaceObjectDeleteTarget &&
        novaWorkspaceObjectDeleteTarget.type === "object" &&
        novaWorkspaceObjectDeleteTarget.id === object.id;
      html += `<div class="ws-card">
        <h3>${novaEscape(object.name)}</h3>
        ${object.description ? `<p class="ws-text">${novaEscape(object.description)}</p>` : ""}
        <p class="motion-note">Home: ${novaEscape(object.homeLocation || "—")}${owner ? " · Owner: " + novaEscape(owner.name) : ""}</p>
        <div class="ws-row">
          <button type="button" class="ws-btn" data-nova-click="novaWorkspaceEditObject" data-nova-arg="${novaEscape(object.id)}">Edit</button>
          <button type="button" class="ws-btn ws-btn-danger" data-nova-click="novaWorkspaceAskDeleteObject" data-nova-arg="${novaEscape(object.id)}">Delete</button>
        </div>
        ${confirming ? novaWorkspaceObjectDeleteConfirmHtml(object) : ""}
      </div>`;
    });
    html += `</div>`;
  }

  // Object add/edit form.
  html += `<h3>${editingObject ? "Edit Object" : "Add Object"}</h3>`;
  html += `<label class="motion-label" for="wsObjectName">Object name</label>
    <input class="motion-input" id="wsObjectName" type="text" value="${editingObject ? novaEscape(editingObject.name) : ""}" placeholder="Example: The Dawn Key">
    <label class="motion-label" for="wsObjectDescription">Description</label>
    <textarea class="motion-input" id="wsObjectDescription" rows="2" placeholder="What is this object?">${editingObject ? novaEscape(editingObject.description || "") : ""}</textarea>
    <label class="motion-label" for="wsObjectHome">Home location</label>
    <input class="motion-input" id="wsObjectHome" type="text" value="${editingObject ? novaEscape(editingObject.homeLocation || "") : ""}" placeholder="Where does it start? Example: The Great Hall">
    <label class="motion-label" for="wsObjectOwner">Owner (optional)</label>
    <select class="motion-select" id="wsObjectOwner">
      <option value="">No owner</option>
      ${characters.map(character => `<option value="${novaEscape(character.id)}"${editingObject && editingObject.ownerCharacterId === character.id ? " selected" : ""}>${novaEscape(character.name)}</option>`).join("")}
    </select>
    <div class="ws-row">
      <button type="button" class="ws-btn ws-btn-primary" data-nova-click="novaWorkspaceSaveObject">${editingObject ? "Save Object" : "Add Object"}</button>
      ${editingObject ? `<button type="button" class="ws-btn" data-nova-click="novaWorkspaceCancelEditObject">Cancel</button>` : ""}
    </div>`;

  // --- Locations ---
  html += `<h3>Locations</h3>`;
  if (!locations.length) {
    html += `<p class="motion-note">No locations yet. Add the first place scenes can be set.</p>`;
  } else {
    html += `<div class="ws-grid">`;
    locations.forEach(location => {
      const confirming =
        novaWorkspaceObjectDeleteTarget &&
        novaWorkspaceObjectDeleteTarget.type === "location" &&
        novaWorkspaceObjectDeleteTarget.id === location.name;
      html += `<div class="ws-card">
        <h3>${novaEscape(location.name)}</h3>
        ${location.description ? `<p class="ws-text">${novaEscape(location.description)}</p>` : ""}
        <div class="ws-row">
          <button type="button" class="ws-btn" data-nova-click="novaWorkspaceEditLocation" data-nova-arg="${novaEscape(location.name)}">Edit</button>
          <button type="button" class="ws-btn ws-btn-danger" data-nova-click="novaWorkspaceAskDeleteLocation" data-nova-arg="${novaEscape(location.name)}">Delete</button>
        </div>
        ${confirming ? novaWorkspaceLocationDeleteConfirmHtml(location) : ""}
      </div>`;
    });
    html += `</div>`;
  }

  // Location add/edit form. Locations are name-keyed: renaming
  // does NOT rewrite scene.location texts (they are free text —
  // decision D25); the user updates scenes via the state editor.
  html += `<h3>${editingLocation ? "Edit Location" : "Add Location"}</h3>`;
  html += `<label class="motion-label" for="wsLocationName">Location name</label>
    <input class="motion-input" id="wsLocationName" type="text" value="${editingLocation ? novaEscape(editingLocation.name) : ""}" placeholder="Example: The Great Hall">
    <label class="motion-label" for="wsLocationDescription">Description</label>
    <textarea class="motion-input" id="wsLocationDescription" rows="2" placeholder="What is this place?">${editingLocation ? novaEscape(editingLocation.description || "") : ""}</textarea>
    <div class="ws-row">
      <button type="button" class="ws-btn ws-btn-primary" data-nova-click="novaWorkspaceSaveLocation">${editingLocation ? "Save Location" : "Add Location"}</button>
      ${editingLocation ? `<button type="button" class="ws-btn" data-nova-click="novaWorkspaceCancelEditLocation">Cancel</button>` : ""}
    </div>`;

  return html;
}

// The two-step delete confirm for an object. When the object is
// used in the current plan's stateChanges, the confirm warns
// that deleting it will block the plan until those changes are
// removed (Section 12.2: an unknown objectId fails the chain).
function novaWorkspaceObjectDeleteConfirmHtml(object) {
  let warning = "Delete this object? This cannot be undone.";
  const plan = novaMotionPlan;
  if (
    plan &&
    plan.projectId === novaWorkspaceProjectId &&
    Array.isArray(plan.scenes)
  ) {
    const used = plan.scenes.some(scene =>
      (scene.stateChanges || []).some(
        change => change && change.objectId === object.id
      )
    );
    if (used) {
      warning =
        "Delete this object? The current plan changes it in a scene — deleting it will block the plan until those changes are removed.";
    }
  }
  return `<div class="ws-confirm">
    <p>${novaEscape(warning)}</p>
    <div class="ws-row">
      <button type="button" class="ws-btn ws-btn-danger" data-nova-click="novaWorkspaceConfirmDeleteObject" data-nova-arg="${novaEscape(object.id)}">Delete</button>
      <button type="button" class="ws-btn" data-nova-click="novaWorkspaceCancelObjectDelete">Cancel</button>
    </div>
  </div>`;
}

function novaWorkspaceLocationDeleteConfirmHtml(location) {
  return `<div class="ws-confirm">
    <p>Delete this location? This cannot be undone. Scenes set in this location keep their location text.</p>
    <div class="ws-row">
      <button type="button" class="ws-btn ws-btn-danger" data-nova-click="novaWorkspaceConfirmDeleteLocation" data-nova-arg="${novaEscape(location.name)}">Delete</button>
      <button type="button" class="ws-btn" data-nova-click="novaWorkspaceCancelObjectDelete">Cancel</button>
    </div>
  </div>`;
}

// Saves the object form (add or edit). The name is required; the
// home location and owner are optional. The save goes through
// novaUpdateProject with the FULL continuity object (the other
// fields are carried forward, never dropped).
function novaWorkspaceSaveObject() {
  const project = novaGetProject(novaWorkspaceProjectId);
  if (!project) {
    novaWorkspaceSetStatus("That project no longer exists.");
    return;
  }
  const name = document.getElementById("wsObjectName").value.trim();
  if (!name) {
    novaWorkspaceSetStatus("An object needs a name.");
    return;
  }
  const description = document
    .getElementById("wsObjectDescription")
    .value.trim();
  const homeLocation = document.getElementById("wsObjectHome").value.trim();
  const ownerCharacterId =
    document.getElementById("wsObjectOwner").value || null;
  const objects = novaGetProjectObjects(project);
  const editingId = novaWorkspaceEditingObjectId;
  let next;
  if (editingId && objects.some(o => o.id === editingId)) {
    next = objects.map(object =>
      object.id === editingId
        ? { ...object, name, description, homeLocation, ownerCharacterId }
        : object
    );
  } else {
    next = [
      ...objects,
      {
        id: novaNewObjectId(),
        name,
        description,
        homeLocation,
        ownerCharacterId
      }
    ];
  }
  const saved = novaUpdateProject(project.id, {
    continuity: {
      ...(project.continuity || {}),
      objects: next
    }
  });
  if (!saved) {
    novaWorkspaceSetStatus("The object could not be saved.");
    return;
  }
  novaWorkspaceEditingObjectId = null;
  novaWorkspaceSetStatus(editingId ? "Object saved." : "Object added.");
  novaRenderWorkspace();
}

function novaWorkspaceEditObject(objectId) {
  novaWorkspaceEditingObjectId = objectId;
  novaWorkspaceObjectDeleteTarget = null;
  novaWorkspaceSetStatus("");
  novaRenderWorkspace();
}

function novaWorkspaceCancelEditObject() {
  novaWorkspaceEditingObjectId = null;
  novaWorkspaceSetStatus("");
  novaRenderWorkspace();
}

function novaWorkspaceAskDeleteObject(objectId) {
  novaWorkspaceObjectDeleteTarget = { type: "object", id: objectId };
  novaWorkspaceSetStatus("");
  novaRenderWorkspace();
}

function novaWorkspaceConfirmDeleteObject(objectId) {
  const project = novaGetProject(novaWorkspaceProjectId);
  if (!project) {
    novaWorkspaceObjectDeleteTarget = null;
    novaWorkspaceSetStatus("That project no longer exists.");
    novaRenderWorkspace();
    return;
  }
  const next = novaGetProjectObjects(project).filter(
    object => object.id !== objectId
  );
  const saved = novaUpdateProject(project.id, {
    continuity: {
      ...(project.continuity || {}),
      objects: next
    }
  });
  novaWorkspaceObjectDeleteTarget = null;
  if (!saved) {
    novaWorkspaceSetStatus("The object could not be deleted.");
    novaRenderWorkspace();
    return;
  }
  if (novaWorkspaceEditingObjectId === objectId) {
    novaWorkspaceEditingObjectId = null;
  }
  novaWorkspaceSetStatus("Object deleted.");
  novaRenderWorkspace();
}

// Saves the location form (add or edit). Locations are
// name-keyed: a duplicate name is refused.
function novaWorkspaceSaveLocation() {
  const project = novaGetProject(novaWorkspaceProjectId);
  if (!project) {
    novaWorkspaceSetStatus("That project no longer exists.");
    return;
  }
  const name = document.getElementById("wsLocationName").value.trim();
  if (!name) {
    novaWorkspaceSetStatus("A location needs a name.");
    return;
  }
  const description = document
    .getElementById("wsLocationDescription")
    .value.trim();
  const locations = novaGetProjectLocations(project);
  const editingName = novaWorkspaceEditingLocationName;
  const duplicate = locations.some(
    location =>
      novaNormalize35b(location.name) === novaNormalize35b(name) &&
      location.name !== editingName
  );
  if (duplicate) {
    novaWorkspaceSetStatus("A location with this name already exists.");
    return;
  }
  let next;
  if (editingName && locations.some(l => l.name === editingName)) {
    next = locations.map(location =>
      location.name === editingName
        ? { name, description }
        : location
    );
  } else {
    next = [...locations, { name, description }];
  }
  const saved = novaUpdateProject(project.id, {
    continuity: {
      ...(project.continuity || {}),
      locations: next
    }
  });
  if (!saved) {
    novaWorkspaceSetStatus("The location could not be saved.");
    return;
  }
  novaWorkspaceEditingLocationName = null;
  novaWorkspaceSetStatus(editingName ? "Location saved." : "Location added.");
  novaRenderWorkspace();
}

function novaWorkspaceEditLocation(name) {
  novaWorkspaceEditingLocationName = name;
  novaWorkspaceObjectDeleteTarget = null;
  novaWorkspaceSetStatus("");
  novaRenderWorkspace();
}

function novaWorkspaceCancelEditLocation() {
  novaWorkspaceEditingLocationName = null;
  novaWorkspaceSetStatus("");
  novaRenderWorkspace();
}

function novaWorkspaceAskDeleteLocation(name) {
  novaWorkspaceObjectDeleteTarget = { type: "location", id: name };
  novaWorkspaceSetStatus("");
  novaRenderWorkspace();
}

function novaWorkspaceConfirmDeleteLocation(name) {
  const project = novaGetProject(novaWorkspaceProjectId);
  if (!project) {
    novaWorkspaceObjectDeleteTarget = null;
    novaWorkspaceSetStatus("That project no longer exists.");
    novaRenderWorkspace();
    return;
  }
  const next = novaGetProjectLocations(project).filter(
    location => location.name !== name
  );
  const saved = novaUpdateProject(project.id, {
    continuity: {
      ...(project.continuity || {}),
      locations: next
    }
  });
  novaWorkspaceObjectDeleteTarget = null;
  if (!saved) {
    novaWorkspaceSetStatus("The location could not be deleted.");
    novaRenderWorkspace();
    return;
  }
  if (novaWorkspaceEditingLocationName === name) {
    novaWorkspaceEditingLocationName = null;
  }
  novaWorkspaceSetStatus("Location deleted.");
  novaRenderWorkspace();
}

function novaWorkspaceCancelObjectDelete() {
  novaWorkspaceObjectDeleteTarget = null;
  novaWorkspaceSetStatus("");
  novaRenderWorkspace();
}

// ---- Scene state controls (Sections 12, 13) ---------------------------

// Per-scene location + object-change + appearance-change controls,
// rendered into #motionSceneState after a plan is built. Project
// plans only (like the 3.5A continuity controls). The chain is
// built once for the render; on a chain error the controls still
// render (the user must be able to REMOVE the offending change),
// with the error shown at the top and no state lines.
function novaRenderSceneStateControls() {
  const container = document.getElementById("motionSceneState");
  if (!container) return;
  const plan = novaMotionPlan;
  if (!plan || !plan.projectId || !Array.isArray(plan.scenes)) {
    container.innerHTML = "";
    return;
  }
  const project = novaGetProject(plan.projectId);
  if (!project) {
    container.innerHTML = "";
    return;
  }
  const cast = Array.isArray(plan.cast) ? plan.cast : [];
  const castCharacters = cast
    .map(id => novaGetCharacter(id))
    .filter(Boolean);
  const chain = novaBuildProductionState(project, plan);
  let html = `<div class="ws-continuity"><h3>Scene State</h3>`;
  html += `<p class="motion-note">Record what changes in each scene: where it is set, what happens to the project's objects, and how the characters' appearance changes. The state line each scene carries into its prompt is shown under its controls.</p>`;
  if (chain.error) {
    html += `<p class="ws-warn">${novaEscape(chain.error)}</p>`;
  }
  plan.scenes.forEach((scene, index) => {
    html += novaSceneStateControlHtml(
      scene,
      index,
      project,
      castCharacters,
      chain.error ? null : chain
    );
  });
  html += `</div>`;
  container.innerHTML = html;
}

// One scene's state controls: location, object changes,
// appearance changes, and the delete-scene button.
function novaSceneStateControlHtml(scene, index, project, castCharacters, chain) {
  const sceneNumber = index + 1;
  const objects = novaGetProjectObjects(project);
  const locations = novaGetProjectLocations(project);
  const stateLine = chain
    ? novaContinuityStateLine(chain, scene, index)
    : "";
  let html =
    `<div class="ws-scene-control"><h4>Scene ${sceneNumber}: ${novaEscape(scene.title || "")}</h4>`;

  // Scene text (title + direction) — the trigger-4 editor
  // (Section 16.2). The Save button is the ONLY commit point:
  // typing in these fields triggers nothing (no input, keydown
  // or blur handler is attached to either field). Saving
  // writes the text and revalidates this scene's decisions
  // synchronously (novaSaveSceneText). The text is escaped on
  // render, as everywhere else in this panel.
  html +=
    `<div class="motion-field"><label class="motion-label" for="wsStateTitle_${index}">Scene title</label>` +
    `<input class="motion-input" id="wsStateTitle_${index}" type="text" value="${novaEscape(scene.title || "")}" placeholder="Scene title"></div>` +
    `<div class="motion-field"><label class="motion-label" for="wsStateDirection_${index}">Scene direction</label>` +
    `<textarea class="motion-textarea" id="wsStateDirection_${index}" rows="3" placeholder="What happens in this scene?">${novaEscape(scene.direction || "")}</textarea></div>` +
    `<p><button class="motion-btn motion-btn-primary" data-nova-click="novaSaveSceneText" data-nova-index="${index}">Save scene text</button> <span class="motion-note">Saving revalidates this scene's continuity decisions.</span></p>`;

  // Location (free text, with the registry as suggestions).
  html +=
    `<div class="motion-field"><label class="motion-label" for="wsStateLocation_${index}">Location</label>` +
    `<input class="motion-input" id="wsStateLocation_${index}" type="text" list="wsStateLocationList" value="${novaEscape(scene.location || "")}" placeholder="Where is this scene set?" data-nova-change="novaSetSceneLocation" data-nova-index="${index}" data-nova-value="1">` +
    `<datalist id="wsStateLocationList">` +
    locations.map(l => `<option value="${novaEscape(l.name)}">`).join("") +
    `</datalist></div>`;

  // The state line this scene carries (read-only).
  if (stateLine) {
    html += `<p class="motion-note">${novaEscape(stateLine)}</p>`;
  }

  // Object changes already declared.
  const stateChanges = Array.isArray(scene.stateChanges)
    ? scene.stateChanges
    : [];
  if (stateChanges.length) {
    html += `<p><strong>Object changes:</strong></p><ul class="ws-state-list">`;
    stateChanges.forEach(change => {
      const name = novaObjectNameById(project, change.objectId);
      let text = name + ": " + change.transition;
      if (change.transition === "move" && change.newLocation) {
        text += " to " + change.newLocation;
      }
      if (change.note) text += " — " + change.note;
      html += `<li>${novaEscape(text)} <button class="motion-btn motion-btn-ghost" data-nova-click="novaRemoveSceneObjectChange" data-nova-index="${index}" data-nova-arg="${novaEscape(change.changeId || "")}">Remove</button></li>`;
    });
    html += `</ul>`;
  }

  // Object change add form.
  if (objects.length) {
    html +=
      `<div class="motion-field"><label class="motion-label" for="wsStateObject_${index}">Object</label>` +
      `<select class="motion-select" id="wsStateObject_${index}">` +
      objects.map(o => `<option value="${novaEscape(o.id)}">${novaEscape(o.name)}</option>`).join("") +
      `</select></div>` +
      `<div class="motion-field"><label class="motion-label" for="wsStateTransition_${index}">Change</label>` +
      `<select class="motion-select" id="wsStateTransition_${index}">` +
      `<option value="lose">Lose it</option><option value="recover">Recover it</option><option value="damage">Damage it</option><option value="destroy">Destroy it</option><option value="move">Move it</option><option value="repair">Repair it</option>` +
      `</select></div>` +
      `<div class="motion-field"><label class="motion-label" for="wsStateNewLocation_${index}">New location (for a move)</label>` +
      `<input class="motion-input" id="wsStateNewLocation_${index}" type="text" placeholder="Where does it go?"></div>` +
      `<div class="motion-field"><label class="motion-label" for="wsStateNote_${index}">Note (optional)</label>` +
      `<input class="motion-input" id="wsStateNote_${index}" type="text" placeholder="Anything to record about this change?"></div>` +
      `<p><button class="motion-btn motion-btn-primary" data-nova-click="novaSaveSceneObjectChange" data-nova-index="${index}">Add object change</button></p>`;
  } else {
    html += `<p class="motion-note">No objects in this project yet — add them in the project workspace.</p>`;
  }

  // Appearance changes already declared.
  const appearanceChanges = Array.isArray(scene.characterStateChanges)
    ? scene.characterStateChanges
    : [];
  if (appearanceChanges.length) {
    html += `<p><strong>Appearance changes:</strong></p><ul class="ws-state-list">`;
    appearanceChanges.forEach(change => {
      const character = novaGetCharacter(change.characterId);
      const name = character ? character.name : change.characterId;
      let text;
      if (change.reversesChangeId) {
        text = name + ": " + change.field + " restored";
      } else {
        text = name + ": " + change.field + " becomes " + change.change;
        if (change.temporary) text += " (temporary)";
      }
      html += `<li>${novaEscape(text)} <button class="motion-btn motion-btn-ghost" data-nova-click="novaRemoveSceneAppearanceChange" data-nova-index="${index}" data-nova-arg="${novaEscape(change.changeId || "")}">Remove</button></li>`;
    });
    html += `</ul>`;
  }

  // Appearance change add form.
  if (castCharacters.length) {
    // The reversal dropdown filters by the selects' initial
    // values: the first cast character and the wardrobe field
    // (Section 13.3, Rev 4/5).
    const reversible = novaReversibleChanges(
      novaMotionPlan,
      castCharacters.length ? castCharacters[0].id : null,
      index,
      "wardrobe"
    );
    html +=
      `<div class="motion-field"><label class="motion-label" for="wsStateCharacter_${index}">Character</label>` +
      `<select class="motion-select" id="wsStateCharacter_${index}" data-nova-change="novaStateCharacterChanged" data-nova-index="${index}">` +
      castCharacters.map(c => `<option value="${novaEscape(c.id)}">${novaEscape(c.name)}</option>`).join("") +
      `</select></div>` +
      `<div class="motion-field"><label class="motion-label" for="wsStateField_${index}">Field</label>` +
      `<select class="motion-select" id="wsStateField_${index}" data-nova-change="novaRebuildReversalOptions" data-nova-index="${index}">` +
      `<option value="wardrobe">Wardrobe</option><option value="hair">Hair</option><option value="injury">Injury</option><option value="armour">Armour</option><option value="general">General note</option>` +
      `</select></div>` +
      `<div class="motion-field"><label class="motion-label" for="wsStateChange_${index}">New description</label>` +
      `<input class="motion-input" id="wsStateChange_${index}" type="text" placeholder="The new effective description, e.g. burned black cloak"></div>` +
      `<div class="motion-field"><label class="motion-label"><input type="checkbox" id="wsStateTemporary_${index}"> Temporary (until reversed)</label></div>` +
      `<div class="motion-field"><label class="motion-label" for="wsStateReverses_${index}">Or reverse an earlier change</label>` +
      `<select class="motion-select" id="wsStateReverses_${index}">` +
      `<option value="">No reversal — this is a new change</option>` +
      reversible.map(r => `<option value="${novaEscape(r.changeId)}">Scene ${r.sceneNumber}: ${novaEscape(r.characterName)} — ${novaEscape(r.field)}: ${novaEscape(r.text)}</option>`).join("") +
      `</select></div>` +
      `<p><button class="motion-btn motion-btn-primary" data-nova-click="novaSaveSceneAppearanceChange" data-nova-index="${index}">Add appearance change</button></p>`;
  }

  html +=
    `<p><button class="motion-btn motion-btn-ghost" data-nova-click="novaDeleteScene" data-nova-index="${index}">Delete this scene</button></p>`;
  html += `</div>`;
  return html;
}

// The forward appearance changes a reversal may target: every
// non-reversal change from scenes 0..sceneIndex, not yet
// reversed, in scene order. `characterId` narrows to one
// character (null = all characters) and `field` narrows to one
// appearance field (null/omitted = all fields) — the editor
// filters by the selected character AND the selected field
// (Section 13.3, Rev 4/5). The chain builder enforces the same
// rule independently; this dropdown is a convenience, not the
// authority.
function novaReversibleChanges(plan, characterId, sceneIndex, field) {
  const out = [];
  if (!plan || !Array.isArray(plan.scenes)) return out;
  const reversed = new Set();
  const limit = Math.min(sceneIndex, plan.scenes.length - 1);
  for (let i = 0; i <= limit; i++) {
    const scene = plan.scenes[i];
    (scene.characterStateChanges || []).forEach(change => {
      if (!change || typeof change !== "object") return;
      if (change.reversesChangeId) {
        reversed.add(change.reversesChangeId);
        return;
      }
      if (characterId && change.characterId !== characterId) return;
      if (field && change.field !== field) return;
      if (!change.changeId) return;
      const character = novaGetCharacter(change.characterId);
      out.push({
        changeId: change.changeId,
        characterId: change.characterId,
        characterName: character ? character.name : change.characterId,
        field: change.field,
        text: change.change || "",
        sceneNumber: i + 1
      });
    });
  }
  return out.filter(entry => !reversed.has(entry.changeId));
}

// Rebuilds the reversal select for the chosen character AND
// field (Section 13.3, Rev 4/5). Called when either select
// changes.
function novaRebuildReversalOptions(index) {
  const character = document.getElementById("wsStateCharacter_" + index);
  const field = document.getElementById("wsStateField_" + index);
  const reverses = document.getElementById("wsStateReverses_" + index);
  if (!character || !field || !reverses || !novaMotionPlan) return;
  const options = novaReversibleChanges(
    novaMotionPlan,
    character.value,
    index,
    field.value
  );
  reverses.innerHTML =
    `<option value="">No reversal — this is a new change</option>` +
    options
      .map(
        r =>
          `<option value="${novaEscape(r.changeId)}">Scene ${r.sceneNumber}: ${novaEscape(r.characterName)} — ${novaEscape(r.field)}: ${novaEscape(r.text)}</option>`
      )
      .join("");
}

// Rebuilds the reversal select for the chosen character (the
// field filter applies too — see novaRebuildReversalOptions).
function novaStateCharacterChanged(index) {
  novaRebuildReversalOptions(index);
}

// Sets a scene's location (free text). A location change affects
// the chain and the warnings but not the prompts (the state line
// carries objects + appearance, not the location), so no prompt
// rebuild is needed — the review + controls refresh.
function novaSetSceneLocation(index, value) {
  if (!novaMotionPlan || !Array.isArray(novaMotionPlan.scenes)) return;
  const scene = novaMotionPlan.scenes[index];
  if (!scene) return;
  const location = typeof value === "string" ? value.trim() : "";
  if ((scene.location || "") === location) return;
  if (location) {
    scene.location = location;
  } else {
    delete scene.location;
  }
  novaMotionPlan.version = (novaMotionPlan.version || 1) + 1;
  novaRenderProductionIdentity();
  novaRenderSceneContinuityControls();
  novaRenderSceneStateControls();
}

// Saves a scene's edited text (title + direction) — the
// trigger-4 commit point (Section 16.2). The Save button in
// the per-scene state editor is the commit action: typing in
// the fields triggers nothing (no input, keydown or blur
// handler calls this function). On commit the text is
// written, the edited scene's decisions are revalidated
// synchronously, the prompts are rebuilt and the displays
// refresh. A scene-text edit NEVER bumps plan.version and
// never updates the watermark (Section 16.2) — this handler
// touches neither. A no-change save is a no-op: the edit was
// not accepted as a change, so nothing is revalidated.
function novaSaveSceneText(index) {
  if (!novaMotionPlan || !Array.isArray(novaMotionPlan.scenes)) return;
  const plan = novaMotionPlan;
  const scene = plan.scenes[index];
  if (!scene || !plan.projectId) return;
  const project = novaGetProject(plan.projectId);
  if (!project) return;
  const titleInput = document.getElementById("wsStateTitle_" + index);
  const directionInput = document.getElementById("wsStateDirection_" + index);
  if (!titleInput || !directionInput) return;
  const title = typeof titleInput.value === "string" ? titleInput.value.trim() : "";
  const direction = typeof directionInput.value === "string" ? directionInput.value.trim() : "";
  if ((scene.title || "") === title && (scene.direction || "") === direction) {
    return;
  }
  scene.title = title;
  scene.direction = direction;
  // Trigger 4: revalidate this scene's decisions NOW, before
  // anything else happens. On a broken chain the function
  // reports the error and leaves the decisions exactly as
  // they were; the text stays saved (a text edit cannot break
  // the chain — the chain depends on declared changes, not on
  // title or direction) and the prompt rebuild is skipped,
  // because it would fail on the same chain error. The prompt
  // refreshes on the next successful rebuild, once the plan
  // is repaired.
  const checked = novaRevalidateSceneAfterAcceptedEdit(project, plan, scene.id);
  if (checked.error) {
    alert(checked.error);
  } else {
    novaRebuildAllScenePrompts();
  }
  novaRenderPlanBrief();
  novaRenderProductionIdentity();
  novaRenderSceneContinuityControls();
  novaRenderSceneStateControls();
}

// Saves a scene's new object change. The change is validated
// against the scene's AFTER-state (the state after the scene's
// existing changes — the new change appends after them). When the
// chain is already broken the save is refused: the plan must be
// repaired (by removing the offending change) before new changes
// are added.
function novaSaveSceneObjectChange(index) {
  if (!novaMotionPlan || !Array.isArray(novaMotionPlan.scenes)) return;
  const plan = novaMotionPlan;
  const scene = plan.scenes[index];
  if (!scene || !plan.projectId) return;
  const project = novaGetProject(plan.projectId);
  if (!project) return;
  const objectSelect = document.getElementById("wsStateObject_" + index);
  const transitionSelect = document.getElementById("wsStateTransition_" + index);
  const newLocationInput = document.getElementById("wsStateNewLocation_" + index);
  const noteInput = document.getElementById("wsStateNote_" + index);
  if (!objectSelect || !transitionSelect) return;
  const objectId = objectSelect.value;
  const transition = transitionSelect.value;
  const newLocation = newLocationInput ? newLocationInput.value.trim() : "";
  const note = noteInput ? noteInput.value.trim() : "";

  const chain = novaBuildProductionState(project, plan);
  if (chain.error) {
    alert(chain.error);
    return;
  }
  const entry = chain.scenes[index];
  const current = entry && entry.objects ? entry.objects[objectId] : null;
  const error = novaValidateObjectChange(current, transition, newLocation);
  if (error) {
    alert("Scene " + (index + 1) + ": " + error);
    return;
  }
  if (!Array.isArray(scene.stateChanges)) scene.stateChanges = [];
  const change = {
    changeId: novaNewChangeId(),
    objectId,
    transition,
    newLocation: transition === "move" ? newLocation : "",
    note
  };
  scene.stateChanges.push(change);
  plan.version = (plan.version || 1) + 1;
  if (!novaRebuildAllScenePrompts()) return;
  novaRenderProductionIdentity();
  novaRenderSceneContinuityControls();
  novaRenderSceneStateControls();
}

function novaRemoveSceneObjectChange(index, changeId) {
  if (!novaMotionPlan || !Array.isArray(novaMotionPlan.scenes)) return;
  const scene = novaMotionPlan.scenes[index];
  if (!scene || !Array.isArray(scene.stateChanges)) return;
  const before = scene.stateChanges.length;
  scene.stateChanges = scene.stateChanges.filter(
    change => change.changeId !== changeId
  );
  if (scene.stateChanges.length === before) return;
  novaMotionPlan.version = (novaMotionPlan.version || 1) + 1;
  if (!novaRebuildAllScenePrompts()) return;
  novaRenderProductionIdentity();
  novaRenderSceneContinuityControls();
  novaRenderSceneStateControls();
}

// Saves a scene's new appearance change. A reversal needs no
// description (the restored value comes from the chain history —
// decision D4); a forward change needs the new effective
// description. The chain rebuild validates the reversal target.
function novaSaveSceneAppearanceChange(index) {
  if (!novaMotionPlan || !Array.isArray(novaMotionPlan.scenes)) return;
  const plan = novaMotionPlan;
  const scene = plan.scenes[index];
  if (!scene || !plan.projectId) return;
  const characterSelect = document.getElementById("wsStateCharacter_" + index);
  const fieldSelect = document.getElementById("wsStateField_" + index);
  const changeInput = document.getElementById("wsStateChange_" + index);
  const temporaryInput = document.getElementById("wsStateTemporary_" + index);
  const reversesSelect = document.getElementById("wsStateReverses_" + index);
  if (!characterSelect || !fieldSelect) return;
  const characterId = characterSelect.value;
  const field = fieldSelect.value;
  const change = changeInput ? changeInput.value.trim() : "";
  const temporary = temporaryInput ? temporaryInput.checked : false;
  const reversesChangeId = reversesSelect ? reversesSelect.value : "";
  if (!reversesChangeId && !change) {
    alert("Enter the new description, or choose a change to reverse.");
    return;
  }
  if (!Array.isArray(scene.characterStateChanges)) {
    scene.characterStateChanges = [];
  }
  scene.characterStateChanges.push({
    changeId: novaNewChangeId(),
    characterId,
    field,
    change: reversesChangeId ? "" : change,
    temporary: reversesChangeId ? false : temporary,
    reversesChangeId: reversesChangeId || null
  });
  plan.version = (plan.version || 1) + 1;
  if (!novaRebuildAllScenePrompts()) {
    // The chain refused the change (e.g. the reversal target is
    // gone) — roll the declaration back out so the plan stays
    // valid.
    scene.characterStateChanges.pop();
    plan.version = plan.version - 1;
    return;
  }
  novaRenderProductionIdentity();
  novaRenderSceneContinuityControls();
  novaRenderSceneStateControls();
}

// Removes an appearance change. A forward change that a later
// change reverses is REFUSED (removing it would dangle the
// reversal and break the chain) — the reversal goes first.
function novaRemoveSceneAppearanceChange(index, changeId) {
  if (!novaMotionPlan || !Array.isArray(novaMotionPlan.scenes)) return;
  const plan = novaMotionPlan;
  const scene = plan.scenes[index];
  if (!scene || !Array.isArray(scene.characterStateChanges)) return;
  const reversing = [];
  plan.scenes.forEach((other, otherIndex) => {
    (other.characterStateChanges || []).forEach(change => {
      if (change && change.reversesChangeId === changeId) {
        reversing.push(otherIndex + 1);
      }
    });
  });
  if (reversing.length) {
    alert(
      "Scene " +
        reversing[0] +
        " reverses this change — remove the reversal first."
    );
    return;
  }
  const before = scene.characterStateChanges.length;
  scene.characterStateChanges = scene.characterStateChanges.filter(
    change => change.changeId !== changeId
  );
  if (scene.characterStateChanges.length === before) return;
  plan.version = (plan.version || 1) + 1;
  if (!novaRebuildAllScenePrompts()) return;
  novaRenderProductionIdentity();
  novaRenderSceneContinuityControls();
  novaRenderSceneStateControls();
}

// ---- Scene deletion (Section 16.2) ------------------------------------

// Deletes a scene. The deletion is allowed even if it breaks the
// chain (the Section 12.2 reorder analogy — the edit is allowed,
// the BUILD is blocked): the scene + its decisions go, the
// version bumps, and the prompt rebuild validates all-or-nothing
// (on error it alerts and touches no prompt). The brief is
// re-rendered (the scene block is gone and the numbering shifts).
function novaDeleteScene(index) {
  if (!novaMotionPlan || !Array.isArray(novaMotionPlan.scenes)) return;
  const plan = novaMotionPlan;
  const scene = plan.scenes[index];
  if (!scene) return;
  const decisions = Array.isArray(plan.continuityDecisions)
    ? plan.continuityDecisions.filter(d => d && d.sceneId === scene.id)
    : [];
  const notice =
    decisions.length > 0
      ? "This scene had " +
        decisions.length +
        " continuity decision" +
        (decisions.length === 1 ? "" : "s") +
        ", which will be removed.\n\n"
      : "";
  if (!confirm(notice + "Delete Scene " + (index + 1) + "?")) return;
  plan.scenes.splice(index, 1);
  novaRemoveSceneDecisions(plan, scene.id);
  plan.version = (plan.version || 1) + 1;
  novaRebuildAllScenePrompts();
  novaRenderPlanBrief();
  novaRenderProductionIdentity();
  novaRenderSceneContinuityControls();
  novaRenderSceneStateControls();
}

// Re-renders the production brief (motionOutput) from the current
// plan, mirroring buildMotionPlan's rendering exactly (same
// template, same fields — the data source is the plan, not the
// build-time locals). Used after a scene deletion, where the
// in-place prompt patch cannot remove a scene block or renumber
// the scenes that follow it.
function novaRenderPlanBrief() {
  const plan = novaMotionPlan;
  const output = document.getElementById("motionOutput");
  const empty = document.getElementById("motionEmpty");
  if (!plan || !output) return;
  if (!Array.isArray(plan.scenes) || !plan.scenes.length) {
    output.innerHTML = "";
    output.style.display = "none";
    if (empty) empty.style.display = "block";
    return;
  }
  const subject = novaExtractSubject(plan.prompt || "");
  const actions = novaDetectActions(plan.prompt || "");
  const elapsed = plan.scenes.reduce(
    (total, scene) => total + (scene.duration || 0),
    0
  );
  const sceneHTML = plan.scenes
    .map(
      (scene, index) => `
    <div class="motion-scene">
      <h3>SCENE ${index + 1}: ${novaEscape(scene.title)}</h3>
      <p><strong>Timeline:</strong> ${scene.start}s – ${scene.end}s</p>
      <p><strong>Duration:</strong> ${scene.duration} seconds</p>
      <p><strong>Visual direction:</strong> ${novaEscape(scene.direction)}</p>
      <p><strong>Camera:</strong> ${novaEscape(scene.camera)}</p>
      <p><strong>Subject movement:</strong> ${novaEscape(scene.motion)}</p>
      <p><strong>Generation prompt:</strong></p>
      <p>${novaEscape(scene.prompt)}</p>
    </div>
  `
    )
    .join("");
  const actionText = actions.length
    ? actions.join(", ")
    : "General subject action";
  output.innerHTML = `
    <h3>NOVA INTELLIGENCE PRODUCTION BRIEF</h3>

    <p><strong>Detected subject:</strong> ${novaEscape(subject)}</p>
    <p><strong>Detected actions:</strong> ${novaEscape(actionText)}</p>
    <p><strong>Generation mode:</strong> ${plan.mode === "text" ? "Text to Video" : "Image to Video"}</p>
    <p><strong>Visual style:</strong> ${novaEscape(plan.style || "")}</p>
    <p><strong>Preferred camera:</strong> ${novaEscape(plan.camera || "")}</p>
    <p><strong>Aspect ratio:</strong> ${novaEscape(plan.ratio || "")}</p>
    <p><strong>Total duration:</strong> ${plan.duration} seconds</p>
    <p><strong>Number of scenes:</strong> ${plan.scenes.length}</p>
    <p><strong>Character identity:</strong> ${novaEscape(plan.character || "Continuity instructions enabled")}</p>

    <h3 class="motion-breakdown-heading">CINEMATIC SCENE BREAKDOWN</h3>
    ${sceneHTML}

    <div class="motion-scene">
      <strong>GLOBAL CONTINUITY RULES</strong>
      <p>Maintain consistent subject identity, anatomy, colours, proportions, environment and lighting across all scenes.</p>
      <p>Preserve the intended action and spatial relationships. Avoid unexplained changes in character appearance or location.</p>
      <p>Final timeline: ${elapsed} seconds.</p>
    </div>

    <p class="motion-note">
      NOVA Prompt Brain 2.0 · Rule-based cinematic planning.
      AI model interpretation and actual video rendering are not yet connected.
    </p>
  `;
  if (empty) empty.style.display = "none";
  output.style.display = "block";
}

// ---- Prompt rebuilds (Sections 12, 14) --------------------------------

// Rebuilds every scene prompt of a plan through the shared
// builder (which includes the state line), using a pre-built
// chain. Returns { error } — on a per-scene error the rebuild
// stops and reports it (earlier scenes keep their new prompts;
// the caller re-validates the chain before calling, so a
// per-scene error here is defensive only).
function novaRebuildPlanPrompts(plan, chain) {
  if (!plan || !Array.isArray(plan.scenes)) {
    return { error: "No plan was supplied for the prompt rebuild." };
  }
  for (let index = 0; index < plan.scenes.length; index++) {
    const scene = plan.scenes[index];
    const rebuilt = novaBuildScenePrompt(plan, scene, chain);
    if (rebuilt.error) {
      return { error: "Scene " + (index + 1) + ": " + rebuilt.error };
    }
    scene.prompt = rebuilt.prompt;
  }
  return { error: null };
}

// Rebuilds ALL scene prompts of the current plan, all-or-nothing:
// the chain is validated FIRST; on error it alerts and touches
// no prompt. On success every prompt is rebuilt (state lines
// refresh across the whole plan — a change in scene N alters
// the lines of scenes N+1...) and the brief is patched in place
// per scene (the 3.5A pattern). Returns true on success.
function novaRebuildAllScenePrompts() {
  const plan = novaMotionPlan;
  if (!plan || !Array.isArray(plan.scenes)) return false;
  if (!plan.projectId) {
    // Standalone plans have no state chain; their prompts carry
    // no state line, so there is nothing to rebuild.
    return true;
  }
  const project = novaGetProject(plan.projectId);
  if (!project) {
    alert("The project for this plan no longer exists.");
    return false;
  }
  const chain = novaBuildProductionState(project, plan);
  if (chain.error) {
    alert(chain.error);
    return false;
  }
  const output = document.getElementById("motionOutput");
  for (let index = 0; index < plan.scenes.length; index++) {
    const scene = plan.scenes[index];
    const oldPrompt = scene.prompt;
    const rebuilt = novaBuildScenePrompt(plan, scene, chain);
    if (rebuilt.error) {
      alert("Scene " + (index + 1) + ": " + rebuilt.error);
      return false;
    }
    scene.prompt = rebuilt.prompt;
    if (output && oldPrompt && oldPrompt !== rebuilt.prompt) {
      output.innerHTML = output.innerHTML.replace(
        novaEscape(oldPrompt),
        novaEscape(rebuilt.prompt)
      );
    }
  }
  return true;
}

// ---- Pre-creation confirmation (Section 16.2) --------------------------

// Renders the creation-confirm panel (the design's exact
// message + Create anyway / Cancel) into #motionCreationConfirm.
function novaShowCreationConfirm(message) {
  const container = document.getElementById("motionCreationConfirm");
  if (!container) return;
  container.innerHTML =
    `<div class="ws-confirm"><p>${novaEscape(message)}</p>` +
    `<div class="ws-row">` +
    `<button type="button" class="ws-btn ws-btn-primary" data-nova-click="novaConfirmCreation">Create anyway</button> ` +
    `<button type="button" class="ws-btn" data-nova-click="novaCancelCreation">Cancel</button>` +
    `</div></div>`;
  novaCurrentPlanWarnings = null;
}

// The confirm button: one-shot confirmation, then re-invoke the
// creation (the internal revalidation is then a no-op — the
// watermark is current after the pre-check).
function novaConfirmCreation() {
  const container = document.getElementById("motionCreationConfirm");
  if (container) container.innerHTML = "";
  novaMotionCreationConfirmed = true;
  generateMotionVideo();
}

// The cancel button: clears the panel; nothing is created.
function novaCancelCreation() {
  const container = document.getElementById("motionCreationConfirm");
  if (container) container.innerHTML = "";
  novaMotionCreationConfirmed = false;
}

// ---- Licence notice before a first generation (Section 19.2) ----------

const NOVA_LICENCE_NOTICE_KEY = "nova-licence-notice-acknowledged";

function novaLicenceNoticeAcknowledged() {
  try {
    return localStorage.getItem(NOVA_LICENCE_NOTICE_KEY) === "yes";
  } catch (error) {
    return false;
  }
}

// Renders the full §3.1/§4 user restrictions + Attachment A(e) into
// #motionCreationConfirm and waits for the user to acknowledge before
// any generation is created. The notice text is the licence's own
// wording, verbatim (LTXV Open Weights License 0.X).
function novaShowLicenceNotice() {
  const container = document.getElementById("motionCreationConfirm");
  if (!container) return;
  container.innerHTML =
    `<div class="ws-confirm"><p><strong>Before your first video: use restrictions</strong></p>` +
    `<p>Videos on NOVA are machine generated (LTX-Video 2B, LTXV Open Weights License 0.X). The licence restricts how the model and its outputs may be used. In the licence's own words:</p>` +
    `<p>3.1. Use-based restrictions as referenced in paragraph 4 MUST be included as an enforceable provision by you in any type of legal agreement (e.g. a license) governing the use and/or distribution of the Model or Derivatives of the Model, and you shall give notice to subsequent users you distribute to, that the Model or Derivatives of the Model are subject to paragraph 4. This provision does not apply to the use of Complementary Material.</p>` +
    `<p>4. Use-based restrictions. The restrictions set forth in Attachment A are considered Use-based restrictions. Therefore, you cannot use the Model and the Derivatives of the Model in violation of the specified restricted uses. You may use the Model subject to this Agreement, including only for lawful purposes and in accordance with the Agreement. &ldquo;Use&rdquo; may include creating any content with, fine-tuning, updating, running, training, evaluating and/or re-parametrizing the Model. You shall require all of your users who use the Model or a Derivative of the Model to comply with the terms of this paragraph 4.</p>` +
    `<p>Attachment A(e): &ldquo;(e) To generate or disseminate information and/or content (e.g. images, code, posts, articles), and place the information and/or content in any context (e.g. bot generating tweets) without expressly and intelligibly disclaiming that the information and/or content is machine generated;&rdquo; The full list of restrictions is on the <a href="about.html#use-restrictions">About page</a>.</p>` +
    `<div class="ws-row">` +
    `<button type="button" class="ws-btn ws-btn-primary" data-nova-click="novaAcknowledgeLicenceNotice">I understand — continue</button> ` +
    `<button type="button" class="ws-btn" data-nova-click="novaCancelCreation">Cancel</button>` +
    `</div></div>`;
}

// The acknowledge button: records the acknowledgement in this
// browser, then re-invokes the generation that was waiting.
function novaAcknowledgeLicenceNotice() {
  const container = document.getElementById("motionCreationConfirm");
  if (container) container.innerHTML = "";
  try {
    localStorage.setItem(NOVA_LICENCE_NOTICE_KEY, "yes");
  } catch (error) {
    // A browser that refuses storage still proceeds: the notice
    // was shown and acknowledged in this session.
  }
  generateMotionVideo();
}

/* ---- End of Stage 3.5B: Production State Manager ---------------------- */

/* ---------- Provider Interface (contract only, Stage 3.1) ----------
   Correction 5: interface definitions + a safe unavailable adapter —
   not actual provider integrations. The first real adapter is 3.4.
   Every adapter implements:
     submit(executionUnit, context) -> { providerJobId, status }
     poll(providerJobId) -> { status, videoUrl?, error? }
     cancel(providerJobId) -> boolean */

const novaUnavailableAdapter = {
  name: "unavailable",
  async submit() {
    return {
      status: "unavailable",
      error: "No video-generation provider is configured."
    };
  },
  async poll() {
    return {
      status: "unavailable",
      error: "No video-generation provider is configured."
    };
  },
  async cancel() {
    return false;
  }
};

/* ---------- Jobs list (minimal UI so saved jobs stay accessible) ---------- */

function novaRenderJobs() {
  const container = document.getElementById("motionJobs");
  const empty = document.getElementById("motionJobsEmpty");
  if (!container) return;

  const jobs = novaLoadJobs();

  if (empty) {
    empty.style.display = jobs.length ? "none" : "block";
  }

  if (!jobs.length) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = jobs
    .map(job => {
      const sceneSummary = job.scenes
        .map(scene => "Scene " + (scene.index + 1) + ": " + scene.status)
        .join(" · ");
      const when = new Date(job.createdAt).toLocaleString();
      return `<div class="motion-scene">
        <strong>${novaEscape(job.id)}</strong><br>
        Created: ${novaEscape(when)}<br>
        Status: ${novaEscape(job.status)}<br>
        Scenes: ${novaEscape(sceneSummary)}<br>
        Character: ${novaEscape(job.characterRef ? job.characterRef.id : "none")}
        ${novaJobReferenceImageLine(job)}
      </div>`;
    })
    .join("");
}

  function toggleMenu() {
    document.getElementById("sidebar")
      .classList.toggle("open");
  }

  function showNotice(section) {
    const notice = document.getElementById("notice");

    notice.style.display = "block";
    notice.textContent =
      section + " is part of the NOVA AI STUDIO development roadmap.";

    document.getElementById("sidebar")
      .classList.remove("open");
  }

  function openTool(tool) {
    const notice = document.getElementById("notice");

    notice.style.display = "block";
    notice.textContent =
      tool + " is being prepared for integration. AI generation is not connected yet.";

    document.getElementById("sidebar")
      .classList.remove("open");

    notice.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });
  }

  function filterTools() {
    const query = document.getElementById("search")
      .value.toLowerCase().trim();

    const cards = document.querySelectorAll(".tool-card");
    let visible = 0;

    cards.forEach(card => {
      const matches =
        card.textContent.toLowerCase().includes(query);

      card.style.display = matches ? "" : "none";

      if (matches) visible++;
    });

    document.getElementById("noResults").style.display =
      visible === 0 ? "block" : "none";
  }
    // NOVA AI WRITING STUDIO FUNCTIONS

  function openWritingStudio() {
    document.getElementById("writingStudio").style.display = "block";
    document.body.style.overflow = "hidden";
  }

  function closeWritingStudio() {
    document.getElementById("writingStudio").style.display = "none";
    document.body.style.overflow = "";
  }

  async function generateWriting() {
    const type = document.getElementById("writingType").value;
    const tone = document.getElementById("writingTone").value;
    const idea = document.getElementById("writingPrompt").value.trim();
    const result = document.getElementById("writingResult");
    const status = document.getElementById("writingStatus");
    const button = document.getElementById("generateWritingButton");

    if (!idea) {
      status.textContent = "Please enter your writing idea first.";
      return;
    }

    const prompt =
      "Act as an expert professional AI writer.\n\n" +
      "CONTENT TYPE: " + type + "\n" +
      "WRITING TONE: " + tone + "\n" +
      "TOPIC AND INSTRUCTIONS: " + idea + "\n\n" +
      "Create original, high-quality, engaging and well-structured content. " +
      "Follow the user's instructions carefully.";

    if (prompt.length > 4000) {
      status.textContent = "Your request is too long. Please shorten it.";
      return;
    }

    button.disabled = true;
    button.textContent = "Generating...";
    status.textContent = "NOVA AI is creating your content...";
    result.style.display = "block";
    result.value = "";

    try {
      const response = await fetch("/api/gemini", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          prompt: prompt
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "AI generation failed.");
      }

      if (!data.text) {
        throw new Error("The AI returned an empty response.");
      }

      result.value = data.text;
      status.textContent = "Your content has been generated successfully!";

    } catch (error) {
      console.error("NOVA Writing Studio Error:", error);
      result.value = "";
      status.textContent =
        "Generation failed: " + error.message +
        ". Please try again.";

    } finally {
      button.disabled = false;
      button.textContent = "Generate Content →";
    }
  }

  function copyWriting() {
    const result = document.getElementById("writingResult");

    if (!result.value.trim()) {
      document.getElementById("writingStatus").textContent =
        "There is nothing to copy yet.";
      return;
    }

    result.select();
    result.setSelectionRange(0, result.value.length);

    const copied = document.execCommand("copy");

    document.getElementById("writingStatus").textContent =
      copied ? "Content copied successfully!" :
      "Please select and copy the content manually.";
  }

  function clearWriting() {
    document.getElementById("writingPrompt").value = "";
    document.getElementById("writingResult").value = "";
    document.getElementById("writingResult").style.display = "none";
    document.getElementById("writingStatus").textContent = "";
  }

// NOVA MOTION — Stage 3.3 startup restoration
novaRenderJobs();
novaRestoreJobs();

// ==========================================
// PHASE 3 — CSP DELEGATED EVENTS + CAPACITY BADGE
// Rev 3 §C-1.9(b): no inline event handlers remain in the page.
// Every button / select / input / form that used onclick, onchange,
// oninput or onsubmit now carries data-nova-click / data-nova-change /
// data-nova-input / data-nova-submit, and these four document-level
// listeners dispatch to the named function. Arguments are carried in
// data-nova-index (integer), data-nova-arg / data-nova-arg2 (strings),
// data-nova-value (the element's current value) and
// data-nova-checked (the element's checked state), in that order;
// a submit handler receives the event and its `false` return still
// prevents submission, exactly as the old inline submit handler did.
// Handler functions are top-level declarations in this classic
// script, so they are reachable as window[name].
// ==========================================

function novaResolveActionHandler(name) {
  if (typeof name !== "string" || !name) return null;
  const fn = window[name];
  return typeof fn === "function" ? fn : null;
}

function novaDelegatedArgs(el, event) {
  const args = [];
  const d = el.dataset;
  if (d.novaIndex !== undefined && d.novaIndex !== "") {
    args.push(Number(d.novaIndex));
  }
  if (d.novaArg !== undefined) args.push(d.novaArg);
  if (d.novaArg2 !== undefined) args.push(d.novaArg2);
  if (d.novaValue !== undefined) args.push(el.value);
  if (d.novaChecked !== undefined) args.push(el.checked);
  return args;
}

function novaHandleDelegated(event, attr, isSubmit) {
  const target = event.target;
  const el = target && target.closest
    ? target.closest("[" + attr + "]")
    : null;
  if (!el) return;
  const fn = novaResolveActionHandler(el.getAttribute(attr));
  if (!fn) return;
  const args = novaDelegatedArgs(el, event);
  if (isSubmit) args.push(event);
  const result = fn.apply(null, args);
  if (isSubmit && result === false) event.preventDefault();
}

document.addEventListener("click", (event) =>
  novaHandleDelegated(event, "data-nova-click", false));
document.addEventListener("change", (event) =>
  novaHandleDelegated(event, "data-nova-change", false));
document.addEventListener("input", (event) =>
  novaHandleDelegated(event, "data-nova-input", false));
document.addEventListener("submit", (event) =>
  novaHandleDelegated(event, "data-nova-submit", true));

// Capacity badge (Rev 2 §4.2, §6.4; Rev 3 §C-1.4). The badge shows
// "Controlled test" in preview, "Temporarily unavailable" when the
// endpoint reports no capacity, and keeps the existing
// "not connected" text when the endpoint is unreachable — it never
// claims availability the endpoint did not report. Until the Worker
// implements GET /api/capacity, the fetch fails and the fallback
// text stands, so this degrades to today's behaviour.
async function novaRefreshCapacity() {
  const badge = document.getElementById("motionCapacityBadge");
  if (!badge) return;
  try {
    const response = await fetch("/api/capacity", { method: "GET" });
    if (!response.ok) return;
    const data = await response.json();
    if (data.available && data.mode === "controlled-test") {
      badge.textContent = "● Controlled test — this is not public generation capacity";
    } else if (data.available) {
      // A bare available:true without the controlled-test mode field
      // is not a capacity claim this UI will repeat (Rev 3 §C-1.4).
      badge.textContent = "● Temporarily unavailable";
    } else {
      badge.textContent = "● Temporarily unavailable — please try again in a few minutes";
    }
  } catch (error) {
    // Endpoint not implemented or unreachable: keep "not connected".
  }
}

// Prompt character counter (Rev 2 §5.1 Q4: 2,000 characters, reject
// over-long prompts, never silently truncate). The counter is display
// only; enforcement is the rejection in buildMotionPlan.
function novaUpdatePromptCount() {
  const promptEl = document.getElementById("motionPrompt");
  const countEl = document.getElementById("motionPromptCount");
  if (!promptEl || !countEl) return;
  countEl.textContent =
    promptEl.value.length.toLocaleString("en-US") + " / 2,000 characters";
}

const novaMotionPromptEl = document.getElementById("motionPrompt");
if (novaMotionPromptEl) {
  novaMotionPromptEl.addEventListener("input", novaUpdatePromptCount);
  novaUpdatePromptCount();
}
