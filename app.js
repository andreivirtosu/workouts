(function () {
  const colors = {
    grid: "#e9e5da",
    axis: "#b9b4a6",
    text: "#4a5963",
    line: "#cc5a2b",
    point: "#1f6f78",
    bar: "#1f6f78"
  };

  const state = {
    workoutsAsc: [],
    exerciseSeries: new Map(),
    dailySeries: [],
    calendarBars: [],
    selectedCalendarDate: null,
    calendarBound: false,
    nextPlanExercises: [],
    nextPlanDone: {},
    nextPlanBound: false,
    liveLoggerBound: false,
    liveTimerIntervalId: null,
    sharedDraftSaveTimerId: null,
    sharedDraftSaveRunId: 0,
    sharedDraftSaveController: null
  };

  const SHARED_WORKOUT_OBJECT_URL = "https://api.restful-api.dev/objects/ff8081819d82fab6019da7edcb1f2a55";
  const WEEKLY_PLAN_UPDATED_AT = "2026-06-01";
  const WORKOUTS_DATA_VERSION = "20260605a";
  const SHARED_DRAFT_RETRY_MAX_ATTEMPTS = 4;
  const SHARED_DRAFT_RETRY_MIN_DELAY_MS = 3 * 60 * 1000;
  const SHARED_DRAFT_RETRY_MAX_DELAY_MS = 5 * 60 * 1000;
  const SHARED_DRAFT_PENDING_STORAGE_KEY = "workout-shared-draft-pending-v1";
  const EXERCISE_DEMOS = {
    "Flat Bench Press": {
      pageUrl: "https://musclewiki.com/exercise/dumbbell-bench-press",
      imageUrl: "https://media.musclewiki.com/media/uploads/og-male-dumbbell-bench-press-front_y8zKZJl.jpg"
    },
    "Incline Bench Press": {
      pageUrl: "https://musclewiki.com/exercise/dumbbell-incline-bench-press",
      imageUrl: "https://media.musclewiki.com/media/uploads/og-male-dumbbell-incline-bench-press-front_q2q0T12.jpg"
    },
    "Row": {
      pageUrl: "https://musclewiki.com/exercise/machine-seated-cable-row?model=f",
      imageUrl: "https://media.musclewiki.com/media/uploads/og-female-machine-seated-cable-row-front.jpg"
    },
    "Rear Delt Fly": {
      pageUrl: "https://musclewiki.com/exercise/dumbbell-rear-delt-fly",
      imageUrl: "https://media.musclewiki.com/media/uploads/og-male-Dumbbells-dumbbell-rear-delt-fly-side.jpg"
    },
    "Lateral Raise": {
      pageUrl: "https://musclewiki.com/exercise/dumbbell-lateral-raise",
      imageUrl: "https://media.musclewiki.com/media/uploads/og-male-Dumbbells-dumbbell-lateral-raise-front.jpg"
    },
    "Lat Pulldown": {
      pageUrl: "https://musclewiki.com/tr-tr/exercise/narrow-pulldown",
      imageUrl: "https://media.musclewiki.com/media/uploads/og-male-Machine-narrow-pulldown-front.jpg"
    }
  };

  function getCurrentPlanName() {
    const activeWorkout = getWeeklyPlan().find((entry) => entry.next);
    return activeWorkout ? activeWorkout.workout : "Lower A";
  }

  async function fetchSharedWorkoutDraft() {
    const response = await fetch(SHARED_WORKOUT_OBJECT_URL, {
      cache: "no-store",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`Load failed (${response.status})`);
    }
    const payload = await response.json();
    return payload && payload.data && typeof payload.data.content === "string" ? payload.data.content : "";
  }

  async function saveSharedWorkoutDraft(text, title, { keepalive = false, signal } = {}) {
    const response = await fetch(SHARED_WORKOUT_OBJECT_URL, {
      method: "PATCH",
      keepalive,
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        name: title || "Last Workout",
        data: {
          content: text || "",
          updated_at: new Date().toISOString()
        }
      })
    });
    if (!response.ok) {
      throw new Error(`Save failed (${response.status})`);
    }
    return response.json();
  }

  function refreshLiveYamlOutput(session) {
    const yamlOutput = document.getElementById("live-yaml-output");
    if (!yamlOutput) return "";
    const yaml = buildLiveSessionYaml(session);
    yamlOutput.value = yaml;
    return yaml;
  }

  function hasLiveSessionProgress(session) {
    if (!session || typeof session !== "object") return false;
    return !!(
      (Array.isArray(session.sets) && session.sets.length) ||
      session.started_at ||
      toNumber(session.bodyweight) !== null ||
      toNumber(session.warmup_run_min) !== null ||
      toNumber(session.cooldown_bike_min) !== null
    );
  }

  function getSharedDraftRetryDelayMs() {
    const span = SHARED_DRAFT_RETRY_MAX_DELAY_MS - SHARED_DRAFT_RETRY_MIN_DELAY_MS;
    return SHARED_DRAFT_RETRY_MIN_DELAY_MS + Math.round(Math.random() * span);
  }

  function loadPendingSharedDraftSave() {
    try {
      const raw = localStorage.getItem(SHARED_DRAFT_PENDING_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      if (typeof parsed.yaml !== "string" || typeof parsed.title !== "string") return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function stopSharedWorkoutDraftActivity() {
    if (state.sharedDraftSaveTimerId) {
      window.clearTimeout(state.sharedDraftSaveTimerId);
      state.sharedDraftSaveTimerId = null;
    }
    if (state.sharedDraftSaveController) {
      state.sharedDraftSaveController.abort();
      state.sharedDraftSaveController = null;
    }
  }

  function savePendingSharedDraftSave(payload) {
    try {
      localStorage.setItem(SHARED_DRAFT_PENDING_STORAGE_KEY, JSON.stringify({
        yaml: payload.yaml || "",
        title: payload.title || "Last Workout",
        saved_at: new Date().toISOString()
      }));
    } catch (err) {
      // Ignore local persistence failures and still attempt remote save.
    }
  }

  function clearPendingSharedDraftSave(payload) {
    try {
      const current = loadPendingSharedDraftSave();
      if (!current) return;
      if (payload && (current.yaml !== payload.yaml || current.title !== payload.title)) return;
      localStorage.removeItem(SHARED_DRAFT_PENDING_STORAGE_KEY);
    } catch (err) {
      // Ignore local cleanup failures.
    }
  }

  function buildSharedDraftSavePayload(session) {
    return {
      yaml: refreshLiveYamlOutput(session),
      title: session.workout_name || getCurrentPlanName()
    };
  }

  function dispatchKeepaliveSharedDraftSave(payload, feedbackEl) {
    if (!payload || !payload.yaml) return;
    savePendingSharedDraftSave(payload);
    void saveSharedWorkoutDraft(payload.yaml, payload.title, { keepalive: true })
      .then(() => {
        clearPendingSharedDraftSave(payload);
        if (feedbackEl) feedbackEl.textContent = "Shared draft auto-saved.";
      })
      .catch(() => {
        // Keep the pending payload so the next page load can retry it.
      });
  }

  async function attemptSharedWorkoutDraftSave({ yaml, title, feedbackEl, runId, attempt, keepalive = false }) {
    if (runId !== state.sharedDraftSaveRunId) return;

    const controller = new AbortController();
    state.sharedDraftSaveController = controller;

    try {
      await saveSharedWorkoutDraft(yaml, title, { keepalive, signal: controller.signal });
      if (runId !== state.sharedDraftSaveRunId) return;
      if (state.sharedDraftSaveController === controller) {
        state.sharedDraftSaveController = null;
      }
      clearPendingSharedDraftSave({ yaml, title });
      if (feedbackEl) feedbackEl.textContent = "Shared draft auto-saved.";
    } catch (err) {
      if (state.sharedDraftSaveController === controller) {
        state.sharedDraftSaveController = null;
      }
      if (err && err.name === "AbortError") return;
      if (runId !== state.sharedDraftSaveRunId) return;
      if (attempt < SHARED_DRAFT_RETRY_MAX_ATTEMPTS) {
        const nextAttempt = attempt + 1;
        const retryDelayMs = getSharedDraftRetryDelayMs();
        if (feedbackEl) {
          feedbackEl.textContent = `Shared draft save failed. Retrying (${nextAttempt}/${SHARED_DRAFT_RETRY_MAX_ATTEMPTS}) in a few minutes...`;
        }
        scheduleSharedWorkoutDraftSaveAttempt({
          yaml,
          title,
          feedbackEl,
          runId,
          attempt: nextAttempt,
          delayMs: retryDelayMs
        });
        return;
      }

      if (feedbackEl) {
        feedbackEl.textContent = `Warning: shared draft auto-save failed after ${SHARED_DRAFT_RETRY_MAX_ATTEMPTS} attempts.`;
      }
    }
  }

  function scheduleSharedWorkoutDraftSaveAttempt({ yaml, title, feedbackEl, runId, attempt, delayMs }) {
    if (state.sharedDraftSaveTimerId) {
      window.clearTimeout(state.sharedDraftSaveTimerId);
    }

    state.sharedDraftSaveTimerId = window.setTimeout(() => {
      if (runId !== state.sharedDraftSaveRunId) return;
      state.sharedDraftSaveTimerId = null;
      void attemptSharedWorkoutDraftSave({ yaml, title, feedbackEl, runId, attempt });
    }, delayMs);
  }

  function queueSharedWorkoutDraftSave(session, feedbackEl) {
    const payload = buildSharedDraftSavePayload(session);
    savePendingSharedDraftSave(payload);
    state.sharedDraftSaveRunId += 1;
    scheduleSharedWorkoutDraftSaveAttempt({
      yaml: payload.yaml,
      title: payload.title,
      feedbackEl,
      runId: state.sharedDraftSaveRunId,
      attempt: 1,
      delayMs: 700
    });
  }

  async function flushSharedWorkoutDraftSave(session, feedbackEl, { keepalive = false } = {}) {
    const payload = buildSharedDraftSavePayload(session);
    savePendingSharedDraftSave(payload);
    stopSharedWorkoutDraftActivity();
    state.sharedDraftSaveRunId += 1;
    await attemptSharedWorkoutDraftSave({
      yaml: payload.yaml,
      title: payload.title,
      feedbackEl,
      runId: state.sharedDraftSaveRunId,
      attempt: 1,
      keepalive
    });
  }

  async function resumePendingSharedDraftSave(feedbackEl) {
    const pending = loadPendingSharedDraftSave();
    if (!pending || !pending.yaml.trim()) return;
    stopSharedWorkoutDraftActivity();
    state.sharedDraftSaveRunId += 1;
    if (feedbackEl) feedbackEl.textContent = "Resuming shared draft sync...";
    await attemptSharedWorkoutDraftSave({
      yaml: pending.yaml,
      title: pending.title || "Last Workout",
      feedbackEl,
      runId: state.sharedDraftSaveRunId,
      attempt: 1,
      keepalive: true
    });
  }

  function toNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "") return null;
      const normalized = trimmed.replace(",", ".");
      const n = Number(normalized);
      return Number.isFinite(n) ? n : null;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function parseDate(dateStr) {
    return new Date(`${dateStr}T00:00:00`);
  }

  function getIsoWeekInfo(input) {
    const date = input instanceof Date ? new Date(input) : parseDate(String(input));
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
    const week1 = new Date(date.getFullYear(), 0, 4);
    week1.setDate(week1.getDate() + 3 - ((week1.getDay() + 6) % 7));
    const week = 1 + Math.round((date.getTime() - week1.getTime()) / 604800000);
    return {
      year: date.getFullYear(),
      week
    };
  }

  function getWeeklyPlanMetaText() {
    const updatedAt = parseDate(WEEKLY_PLAN_UPDATED_AT);
    const { year, week } = getIsoWeekInfo(updatedAt);
    const formattedDate = updatedAt.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric"
    });
    return `Plan for ${year}-W${String(week).padStart(2, "0")} · updated ${formattedDate}`;
  }

  function formatDateShort(dateStr) {
    const d = parseDate(dateStr);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function addDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  function toIsoDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function canonicalExerciseName(name) {
    const raw = (name || "").toLowerCase();
    if (raw.includes("leg press")) return "Leg Press";
    if (raw.includes("incline") && raw.includes("bench")) return "Incline Bench Press";
    if (raw.includes("flat") && raw.includes("bench")) return "Flat Bench Press";
    if (raw.includes("machine chest press") || raw === "chest press") return "Machine Chest Press";
    if (raw.includes("chest supported row") || raw.includes("cable row") || raw.includes("seated cable row")) return "Row";
    if (raw.includes("lat pulldown")) return "Lat Pulldown";
    if (raw.includes("shoulder press")) return "Shoulder Press";
    if (raw.includes("biceps curl")) return "Biceps Curl";
    if (raw.includes("triceps")) return "Triceps Pushdown";
    if (raw.includes("leg curl")) return "Leg Curl";
    if (raw.includes("rotary calf") || raw === "calf") return "Rotary Calf";
    if (raw.includes("back extension")) return "Back Extension";
    if (raw.includes("squat")) return "Squat";
    if (raw.includes("rear delt")) return "Rear Delt Fly";
    if (raw.includes("lateral raise")) return "Lateral Raise";
    if (raw.includes("hang")) return "Hang";
    if (raw.includes("plank")) return "Plank";
    if (raw.includes("farmer")) return "Farmer's Carry";
    return name || "Unknown";
  }

  function getExerciseCategory(name) {
    const raw = canonicalExerciseName(name).toLowerCase();
    if (raw.includes("bench") || raw.includes("chest")) return "Chest";
    if (raw.includes("row") || raw.includes("pulldown")) return "Back";
    if (raw.includes("leg") || raw.includes("squat") || raw.includes("calf")) return "Legs";
    if (raw.includes("shoulder") || raw.includes("rear delt") || raw.includes("lateral raise")) return "Shoulders";
    if (raw.includes("biceps") || raw.includes("triceps")) return "Arms";
    if (raw.includes("plank") || raw.includes("hang") || raw.includes("carry") || raw.includes("extension")) return "Core";
    return "Other";
  }

  function getExerciseCategoryToken(category) {
    switch (category) {
      case "Chest": return "chest";
      case "Back": return "back";
      case "Legs": return "legs";
      case "Shoulders": return "shoulders";
      case "Arms": return "arms";
      case "Core": return "core";
      default: return "other";
    }
  }

  function getExerciseInitials(name) {
    return String(name || "Exercise")
      .split(/[\s/()-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "EX";
  }

  function buildExerciseLibrary(workoutsAsc) {
    const library = new Map();

    workoutsAsc.forEach((workout) => {
      const workoutDate = String(workout.date || "");
      const exercises = Array.isArray(workout.exercises) ? workout.exercises : [];

      exercises.forEach((exercise) => {
        const displayName = String(exercise.name || "Exercise");
        const canonical = canonicalExerciseName(displayName);
        if (!library.has(canonical)) {
          library.set(canonical, {
            canonical,
            displayName: canonical,
            category: getExerciseCategory(canonical),
            aliases: new Set(),
            sessions: 0,
            totalSets: 0,
            lastDate: null,
            topWeight: null,
            topReps: null,
            topDuration: null
          });
        }

        const entry = library.get(canonical);
        entry.aliases.add(displayName);
        entry.sessions += 1;
        entry.lastDate = workoutDate;

        const sets = Array.isArray(exercise.sets) ? exercise.sets : [];
        entry.totalSets += sets.length;

        sets.forEach((set) => {
          const weight = toNumber(set.weight_kg);
          const reps = toNumber(set.reps);
          const duration = toNumber(set.duration_sec);
          if (weight !== null && (entry.topWeight === null || weight > entry.topWeight)) entry.topWeight = weight;
          if (reps !== null && (entry.topReps === null || reps > entry.topReps)) entry.topReps = reps;
          if (duration !== null && (entry.topDuration === null || duration > entry.topDuration)) entry.topDuration = duration;
        });
      });
    });

    return Array.from(library.values())
      .map((entry) => ({
        ...entry,
        aliases: Array.from(entry.aliases).sort(),
        token: getExerciseCategoryToken(entry.category),
        initials: getExerciseInitials(entry.displayName),
        demo: EXERCISE_DEMOS[entry.canonical] || null
      }))
      .sort((a, b) => {
        if (a.category !== b.category) return a.category.localeCompare(b.category);
        return a.displayName.localeCompare(b.displayName);
      });
  }

  function expandPlanExerciseNames(label) {
    return String(label || "")
      .split(/\s+or\s+|\s*\/\s*/i)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  function buildWorkoutMetrics(workout) {
    const exercises = Array.isArray(workout.exercises) ? workout.exercises : [];
    let sets = 0;
    let reps = 0;

    exercises.forEach((ex) => {
      const exSets = Array.isArray(ex.sets) ? ex.sets : [];
      sets += exSets.length;

      exSets.forEach((set) => {
        const setReps = toNumber(set.reps);
        if (setReps !== null) reps += setReps;
      });
    });

    return { sets, reps };
  }

  function getWorkoutDurationMinutes(workout) {
    const direct = toNumber(workout && workout.duration_min);
    if (direct !== null) return direct;

    const startedAt = workout && typeof workout.started_at === "string" ? workout.started_at : null;
    const endedAt = workout && typeof workout.ended_at === "string" ? workout.ended_at : null;
    if (!startedAt || !endedAt) return null;

    const start = new Date(startedAt);
    const end = new Date(endedAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    const diffMs = Math.max(0, end.getTime() - start.getTime());
    return Math.round(diffMs / 60000);
  }

  function prepareExerciseSeries(workoutsAsc) {
    const map = new Map();

    workoutsAsc.forEach((workout) => {
      const date = workout.date;
      const exercises = Array.isArray(workout.exercises) ? workout.exercises : [];

      exercises.forEach((ex) => {
        const key = canonicalExerciseName(ex.name);
        const exSets = Array.isArray(ex.sets) ? ex.sets : [];
        const weights = exSets
          .map((set) => toNumber(set.weight_kg))
          .filter((weight) => weight !== null);

        if (!weights.length) return;

        const topWeight = Math.max(...weights);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({ date, value: topWeight });
      });
    });

    return map;
  }

  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const baseHeight = Number(canvas.dataset.baseHeight || canvas.getAttribute("height")) || 220;
    if (!canvas.dataset.baseHeight) canvas.dataset.baseHeight = String(baseHeight);
    canvas.style.width = "100%";
    canvas.style.height = `${baseHeight}px`;

    const width = Math.max(1, canvas.clientWidth);

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(baseHeight * dpr);

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width, height: baseHeight };
  }

  function drawAxes(ctx, width, height, opts) {
    const pad = opts.pad;
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;

    const gridLines = 4;
    for (let i = 0; i <= gridLines; i += 1) {
      const y = pad.top + ((height - pad.top - pad.bottom) * i) / gridLines;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(width - pad.right, y);
      ctx.stroke();
    }

    ctx.strokeStyle = colors.axis;
    ctx.beginPath();
    ctx.moveTo(pad.left, height - pad.bottom);
    ctx.lineTo(width - pad.right, height - pad.bottom);
    ctx.stroke();
  }

  function drawLineChart(canvas, labels, values, lineColor) {
    if (!canvas) return;
    const { ctx, width, height } = setupCanvas(canvas);
    const pad = { top: 18, right: 12, bottom: 34, left: 44 };
    ctx.clearRect(0, 0, width, height);

    if (!values.length) return;

    drawAxes(ctx, width, height, { pad });

    const minV = Math.min(...values);
    const maxV = Math.max(...values);
    const range = Math.max(1, maxV - minV);

    const xStep = values.length > 1 ? (width - pad.left - pad.right) / (values.length - 1) : 0;

    function xAt(i) {
      return pad.left + i * xStep;
    }

    function yAt(v) {
      return pad.top + (1 - (v - minV) / range) * (height - pad.top - pad.bottom);
    }

    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2.5;
    ctx.beginPath();

    values.forEach((v, i) => {
      const x = xAt(i);
      const y = yAt(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.stroke();

    ctx.fillStyle = colors.point;
    values.forEach((v, i) => {
      const x = xAt(i);
      const y = yAt(v);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.fillStyle = colors.text;
    ctx.font = "12px 'Avenir Next', 'Trebuchet MS', sans-serif";
    ctx.textAlign = "left";
    const formatAxisValue = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
    ctx.fillText(formatAxisValue(maxV), 6, pad.top + 4);
    ctx.fillText(formatAxisValue(minV), 6, height - pad.bottom);

    ctx.textAlign = "center";
    const tickIndexes = values.length <= 4 ? values.map((_, i) => i) : [0, Math.floor((values.length - 1) / 2), values.length - 1];
    tickIndexes.forEach((i) => {
      ctx.fillText(labels[i], xAt(i), height - 10);
    });
  }

  function drawBarChart(canvas, labels, values) {
    if (!canvas) return;
    const { ctx, width, height } = setupCanvas(canvas);
    const pad = { top: 16, right: 12, bottom: 34, left: 38 };
    ctx.clearRect(0, 0, width, height);

    if (!values.length) return;

    drawAxes(ctx, width, height, { pad });

    const maxV = Math.max(...values);
    const chartW = width - pad.left - pad.right;
    const chartH = height - pad.top - pad.bottom;
    const slotW = chartW / values.length;
    const barW = Math.max(10, slotW * 0.55);

    values.forEach((v, i) => {
      const h = maxV > 0 ? (v / maxV) * chartH : 0;
      const x = pad.left + i * slotW + (slotW - barW) / 2;
      const y = height - pad.bottom - h;
      ctx.fillStyle = colors.bar;
      ctx.fillRect(x, y, barW, h);
    });

    ctx.fillStyle = colors.text;
    ctx.font = "12px 'Avenir Next', 'Trebuchet MS', sans-serif";
    ctx.textAlign = "center";
    const tickIndexes = labels.length <= 8
      ? labels.map((_, i) => i)
      : [0, Math.floor((labels.length - 1) / 3), Math.floor((labels.length - 1) * 2 / 3), labels.length - 1];

    tickIndexes.forEach((i) => {
      const label = labels[i];
      const x = pad.left + i * slotW + slotW / 2;
      ctx.fillText(label, x, height - 10);
    });
  }

  function drawCanvasMessage(canvas, message) {
    if (!canvas) return;
    const { ctx, width, height } = setupCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#4a5963";
    ctx.font = "14px 'Avenir Next', 'Trebuchet MS', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(message, width / 2, height / 2);
  }

  function buildDailyWorkoutSeries(workoutsAsc) {
    if (!workoutsAsc.length) return [];

    const workoutsByDate = new Map();
    workoutsAsc.forEach((w) => {
      const key = String(w.date);
      if (!workoutsByDate.has(key)) workoutsByDate.set(key, []);
      workoutsByDate.get(key).push(w);
    });

    const start = parseDate(String(workoutsAsc[0].date));
    const end = parseDate(String(workoutsAsc[workoutsAsc.length - 1].date));
    const days = [];

    for (let cursor = new Date(start); cursor <= end; cursor = addDays(cursor, 1)) {
      const key = toIsoDate(cursor);
      const workouts = workoutsByDate.get(key) || [];
      days.push({
        date: key,
        label: formatDateShort(key),
        count: workouts.length,
        workouts
      });
    }

    return days;
  }

  function getWorkoutType(workoutName) {
    const raw = String(workoutName || "").trim().toLowerCase();
    if (raw.startsWith("upper")) return "Upper";
    if (raw.startsWith("lower")) return "Lower";
    if (raw.startsWith("full")) return "Full Body";
    if (raw.startsWith("push")) return "Push";
    if (raw.startsWith("pull")) return "Pull";
    if (raw.includes("cardio")) return "Cardio";
    return "Other";
  }

  function getCalendarDayType(day) {
    if (!day || !day.count) return "Rest";
    const types = [...new Set((day.workouts || []).map((workout) => getWorkoutType(workout.workout_name)))];
    if (types.length > 1) return "Mixed";
    return types[0] || "Other";
  }

  function getCalendarTypeColor(type) {
    switch (type) {
      case "Upper":
        return "#5b8def";
      case "Lower":
        return "#2aa876";
      case "Full Body":
        return "#c97a2b";
      case "Push":
        return "#c45c7a";
      case "Pull":
        return "#7b6fd6";
      case "Cardio":
        return "#00a6b2";
      case "Mixed":
        return "#4a5963";
      case "Rest":
        return "#e7ebf0";
      default:
        return "#9aa7b3";
    }
  }

  function getCalendarLegendItems(days) {
    const present = new Set(days.filter((day) => day.count).map((day) => getCalendarDayType(day)));
    const ordered = ["Upper", "Lower", "Full Body", "Push", "Pull", "Cardio", "Mixed", "Other", "Rest"]
      .filter((type) => type === "Rest" || present.has(type));
    return ordered.map((type) => ({ type, color: getCalendarTypeColor(type) }));
  }

  function computeStreaks(days) {
    if (!days.length) return { current: 0, longest: 0 };

    const weeks = [];
    const firstWeekStart = startOfWeek(parseDate(days[0].date));
    const lastWeekStart = startOfWeek(parseDate(days[days.length - 1].date));

    for (let cursor = new Date(firstWeekStart); cursor <= lastWeekStart; cursor = addDays(cursor, 7)) {
      const weekStart = toIsoDate(cursor);
      const weekEnd = toIsoDate(addDays(cursor, 6));
      const workouts = days
        .filter((day) => day.date >= weekStart && day.date <= weekEnd)
        .reduce((sum, day) => sum + day.count, 0);
      weeks.push({ weekStart, workouts, hitTarget: workouts >= 3 });
    }

    let current = 0;
    let longest = 0;
    let running = 0;

    weeks.forEach((week) => {
      if (week.hitTarget) {
        running += 1;
        longest = Math.max(longest, running);
      } else {
        running = 0;
      }
    });

    let currentIndex = weeks.length - 1;
    const thisWeekStart = toIsoDate(startOfWeek(new Date()));
    if (currentIndex >= 0 && weeks[currentIndex].weekStart === thisWeekStart && !weeks[currentIndex].hitTarget) {
      currentIndex -= 1;
    }

    for (let i = currentIndex; i >= 0; i -= 1) {
      if (weeks[i].hitTarget) current += 1;
      else break;
    }

    return { current, longest };
  }

  function computeWeeklyAverage(days) {
    if (!days.length) return 0;
    const totalWorkouts = days.reduce((sum, day) => sum + day.count, 0);
    const totalWeeks = Math.max(1, Math.ceil(days.length / 7));
    return totalWorkouts / totalWeeks;
  }

  function computeCurrentMonthTotal(days) {
    if (!days.length) return 0;
    const latest = parseDate(days[days.length - 1].date);
    const month = latest.getMonth();
    const year = latest.getFullYear();
    return days
      .filter((day) => {
        const date = parseDate(day.date);
        return date.getFullYear() === year && date.getMonth() === month;
      })
      .reduce((sum, day) => sum + day.count, 0);
  }

  function computeCurrentMonthTrainingDays(days) {
    if (!days.length) return 0;
    const latest = parseDate(days[days.length - 1].date);
    const month = latest.getMonth();
    const year = latest.getFullYear();
    return days.filter((day) => {
      if (!day.count) return false;
      const date = parseDate(day.date);
      return date.getFullYear() === year && date.getMonth() === month;
    }).length;
  }

  function renderActivitySummary(days) {
    const container = document.getElementById("activity-summary");
    if (!container) return;

    if (!days.length) {
      container.innerHTML = "";
      return;
    }

    const streaks = computeStreaks(days);
    const currentMonthTotal = computeCurrentMonthTotal(days);
    const currentMonthTrainingDays = computeCurrentMonthTrainingDays(days);
    const weeklyAverage = computeWeeklyAverage(days);
    const latestMonthLabel = parseDate(days[days.length - 1].date).toLocaleDateString(undefined, { month: "short" });

    container.innerHTML = `
      <article class="activity-stat">
        <p class="activity-stat-label">Current Streak</p>
        <p class="activity-stat-value">${streaks.current}</p>
        <p class="activity-stat-note">Consecutive weeks with 3+ workouts</p>
      </article>
      <article class="activity-stat">
        <p class="activity-stat-label">Longest Streak</p>
        <p class="activity-stat-value">${streaks.longest}</p>
        <p class="activity-stat-note">Best run of 3+ workout weeks</p>
      </article>
      <article class="activity-stat">
        <p class="activity-stat-label">Avg / Week</p>
        <p class="activity-stat-value">${weeklyAverage.toFixed(1)}</p>
        <p class="activity-stat-note">Across ${Math.max(1, Math.ceil(days.length / 7))} tracked weeks</p>
      </article>
      <article class="activity-stat">
        <p class="activity-stat-label">This Month</p>
        <p class="activity-stat-value">${currentMonthTotal}</p>
        <p class="activity-stat-note">${currentMonthTrainingDays} active day${currentMonthTrainingDays === 1 ? "" : "s"} in ${latestMonthLabel}</p>
      </article>
    `;
  }

  function renderCalendarLegend(days) {
    const container = document.getElementById("calendar-legend");
    if (!container) return;
    const items = getCalendarLegendItems(days);
    container.innerHTML = items.map((item) => `
      <span class="calendar-legend-item">
        <span class="calendar-legend-swatch" style="background:${item.color}"></span>
        <span>${escapeHtml(item.type)}</span>
      </span>
    `).join("");
  }

  function renderCalendarDayDetail(day) {
    const detail = document.getElementById("calendar-day-detail");
    if (!detail) return;

    if (!day) {
      detail.textContent = "Select a day on the chart to see workout details.";
      return;
    }

    if (!day.count) {
      detail.innerHTML = `<strong>${escapeHtml(day.date)}</strong>: Rest day`;
      return;
    }

    const workoutsHtml = day.workouts
      .map((workout) => {
        const exercises = Array.isArray(workout.exercises) ? workout.exercises : [];
        const exercisesHtml = exercises
          .map((exercise) => {
            const sets = Array.isArray(exercise.sets) ? exercise.sets : [];
            const setsText = sets.map(formatSet).join(" | ") || "not logged";
            return `<div class="calendar-detail-ex"><strong>${escapeHtml(exercise.name || "Exercise")}:</strong> ${escapeHtml(setsText)}</div>`;
          })
          .join("");

        return `
          <div class="calendar-detail-workout">
            <div><strong>${escapeHtml(workout.workout_name || "Workout")}</strong></div>
            <div class="calendar-detail-meta">Duration: ${escapeHtml(formatDuration(workout))}</div>
            <div class="calendar-detail-meta">Warmup: ${escapeHtml(formatActivities(workout.warmup))}</div>
            <div class="calendar-detail-list">${exercisesHtml || "<div class=\"calendar-detail-ex\">No exercises logged</div>"}</div>
            <div class="calendar-detail-meta">Cooldown: ${escapeHtml(formatActivities(workout.cooldown))}</div>
          </div>
        `;
      })
      .join("");

    detail.innerHTML = `
      <div><strong>${escapeHtml(day.date)}</strong></div>
      ${workoutsHtml}
    `;
  }

  function pickDefaultCalendarDate(days) {
    const latestWithWorkout = [...days].reverse().find((d) => d.count > 0);
    return latestWithWorkout ? latestWithWorkout.date : (days[0] ? days[0].date : null);
  }

  function getUserLocale() {
    if (typeof navigator !== "undefined" && navigator.language) return navigator.language;
    return undefined;
  }

  function getLocaleWeekStart() {
    try {
      if (typeof Intl !== "undefined" && typeof Intl.Locale === "function") {
        const locale = new Intl.Locale(getUserLocale());
        if (locale.weekInfo && Number.isInteger(locale.weekInfo.firstDay)) {
          return locale.weekInfo.firstDay % 7;
        }
      }
    } catch (err) {
      // Fall back to Monday-first if weekInfo is unavailable.
    }
    return 1;
  }

  function getWeekdayIndex(date) {
    const localeWeekStart = getLocaleWeekStart();
    return (date.getDay() - localeWeekStart + 7) % 7;
  }

  function getWeekdayLabels() {
    const formatter = new Intl.DateTimeFormat(getUserLocale(), { weekday: "narrow" });
    const baseSunday = new Date(2026, 4, 3);
    const localeWeekStart = getLocaleWeekStart();
    const labels = [];
    for (let i = 0; i < 7; i += 1) {
      const day = addDays(baseSunday, (localeWeekStart + i) % 7);
      labels.push(formatter.format(day));
    }
    return labels;
  }

  function startOfWeek(date) {
    const start = new Date(date);
    start.setDate(start.getDate() - getWeekdayIndex(start));
    return start;
  }

  function endOfWeek(date) {
    const end = new Date(date);
    end.setDate(end.getDate() + (6 - getWeekdayIndex(end)));
    return end;
  }

  function diffDays(a, b) {
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }

  function startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  function addMonths(date, months) {
    return new Date(date.getFullYear(), date.getMonth() + months, 1);
  }

  function buildCalendarMonthLabels({ firstDate, lastDate, rangeStart, startX, cellSize, gap }) {
    const labels = [];
    let cursor = startOfMonth(firstDate);

    while (cursor <= lastDate) {
      const anchor = cursor < firstDate ? firstDate : cursor;
      const weekIndex = Math.floor(diffDays(rangeStart, anchor) / 7);
      const x = startX + weekIndex * (cellSize + gap);
      const label = cursor.toLocaleDateString(undefined, { month: "short" });
      const previous = labels[labels.length - 1];

      if (!previous || x - previous.x >= 26) {
        labels.push({ label, x });
      }

      cursor = addMonths(cursor, 1);
    }

    return labels;
  }

  function drawCalendarChart(canvas, days) {
    if (!canvas) return;
    const { ctx, width, height } = setupCanvas(canvas);
    const pad = { top: 28, right: 12, bottom: 12, left: 34 };
    ctx.clearRect(0, 0, width, height);

    if (!days.length) {
      state.calendarBars = [];
      drawCanvasMessage(canvas, "No workout days yet.");
      return;
    }

    const dateMap = new Map(days.map((day) => [day.date, day]));
    const firstDate = parseDate(days[0].date);
    const lastDate = parseDate(days[days.length - 1].date);
    const rangeStart = startOfWeek(firstDate);
    const rangeEnd = endOfWeek(lastDate);
    const totalWeeks = Math.floor(diffDays(rangeStart, rangeEnd) / 7) + 1;
    const chartW = width - pad.left - pad.right;
    const chartH = height - pad.top - pad.bottom;
    const gap = totalWeeks > 26 ? 2 : 3;
    const cellSize = Math.max(4, Math.min(18, Math.floor(Math.min((chartW - gap * (totalWeeks - 1)) / totalWeeks, (chartH - gap * 6) / 7))));
    const startX = pad.left;
    const startY = pad.top;
    const monthLabels = buildCalendarMonthLabels({ firstDate, lastDate, rangeStart, startX, cellSize, gap });
    const cells = [];

    ctx.fillStyle = colors.text;
    ctx.font = "12px 'Avenir Next', 'Trebuchet MS', sans-serif";
    ctx.textAlign = "left";
    const weekdayLabels = getWeekdayLabels();
    weekdayLabels.forEach((label, row) => {
      if (row % 2 === 1) {
        const y = startY + row * (cellSize + gap) + cellSize * 0.72;
        ctx.fillText(label, 8, y);
      }
    });

    for (let cursor = new Date(rangeStart); cursor <= rangeEnd; cursor = addDays(cursor, 1)) {
      const iso = toIsoDate(cursor);
      const day = dateMap.get(iso) || { date: iso, label: formatDateShort(iso), count: 0, workouts: [] };
      const weekIndex = Math.floor(diffDays(rangeStart, cursor) / 7);
      const weekday = getWeekdayIndex(cursor);
      const x = startX + weekIndex * (cellSize + gap);
      const y = startY + weekday * (cellSize + gap);
      const selected = state.selectedCalendarDate === day.date;

      ctx.fillStyle = getCalendarTypeColor(getCalendarDayType(day));
      ctx.fillRect(x, y, cellSize, cellSize);

      if (selected) {
        ctx.strokeStyle = "#cc5a2b";
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 1, y - 1, cellSize + 2, cellSize + 2);
      } else {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, cellSize - 1, cellSize - 1);
      }

      cells.push({ x, y, w: cellSize, h: cellSize, day });
    }

    monthLabels.forEach((item) => {
      ctx.fillStyle = colors.text;
      ctx.fillText(item.label, item.x, 16);
    });

    state.calendarBars = cells;
  }

  function bindCalendarInteractions() {
    if (state.calendarBound) return;
    const canvas = document.getElementById("calendar-chart");
    if (!canvas) return;

    canvas.addEventListener("mousemove", (event) => {
      const x = event.offsetX;
      const y = event.offsetY;
      const hit = state.calendarBars.find((bar) => x >= bar.x && x <= bar.x + bar.w && y >= bar.y && y <= bar.y + bar.h);
      canvas.style.cursor = hit ? "pointer" : "default";
    });

    canvas.addEventListener("click", (event) => {
      const x = event.offsetX;
      const y = event.offsetY;
      const hit = state.calendarBars.find((bar) => x >= bar.x && x <= bar.x + bar.w && y >= bar.y && y <= bar.y + bar.h);
      if (!hit) return;
      state.selectedCalendarDate = hit.day.date;
      renderCalendarDayDetail(hit.day);
      drawCalendarChart(canvas, state.dailySeries);
    });

    state.calendarBound = true;
  }

  function renderKpis(workoutsAsc) {
    const totals = workoutsAsc.reduce(
      (acc, workout) => {
        const m = buildWorkoutMetrics(workout);
        acc.sets += m.sets;
        acc.reps += m.reps;
        return acc;
      },
      { sets: 0, reps: 0 }
    );

    const workoutsEl = document.getElementById("kpi-workouts");
    const setsEl = document.getElementById("kpi-sets");
    const repsEl = document.getElementById("kpi-reps");
    if (workoutsEl) workoutsEl.textContent = String(workoutsAsc.length);
    if (setsEl) setsEl.textContent = String(totals.sets);
    if (repsEl) repsEl.textContent = String(totals.reps);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatSet(set) {
    const weight = toNumber(set.weight_kg);
    const reps = toNumber(set.reps);
    const duration = toNumber(set.duration_sec);
    const note = (set && typeof set.note === "string" && set.note.trim()) ? set.note.trim() : null;

    let base = "set logged";
    if (weight !== null && reps !== null) base = `${weight}kg x ${reps}`;
    else if (reps !== null) base = `${reps} reps`;
    else if (duration !== null) base = `${duration}s`;
    else if (weight !== null) base = `${weight}kg`;
    return note ? `${base} (${note})` : base;
  }

  function formatActivities(activities) {
    if (!Array.isArray(activities) || !activities.length) return "not logged";
    return activities
      .map((a) => {
        const activity = a.activity || "Activity";
        const min = toNumber(a.duration_min);
        const suffix = min !== null ? ` ${min} min` : "";
        return `${activity}${suffix}`;
      })
      .join(", ");
  }

  function formatDuration(workout) {
    const minutes = getWorkoutDurationMinutes(workout);
    return minutes === null ? "not logged" : `${minutes} min`;
  }

  function getTodayIso() {
    return toIsoDate(new Date());
  }

  function toMinuteStamp(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  function getLiveStorageKey() {
    return "workout-live-session-v1";
  }

  function getActivePlanStorageKey() {
    return "workout-active-plan-v1";
  }

  function getNextPlanStorageKey(date = getTodayIso()) {
    return `workout-next-plan-done-v1:${date}`;
  }

  function loadActivePlanId() {
    try {
      return localStorage.getItem(getActivePlanStorageKey()) || "";
    } catch (err) {
      return "";
    }
  }

  function saveActivePlanId(planId) {
    localStorage.setItem(getActivePlanStorageKey(), planId);
  }

  function getWeeklyPlan() {
    const selectedId = loadActivePlanId();
    const weeklyPlan = [
      {
        id: "monday-recovery",
        day: "Monday",
        workout: "Recovery",
        selectable: false,
        items: [
          "Back flare deload: walk 20-30 min total, easy pace",
          "Heat/sauna optional: 10-15 min, no aggressive stretching",
          "Gentle mobility only: cat-cow, pelvic tilts, easy breathing"
        ]
      },
      {
        id: "tuesday-upper-a",
        day: "Tuesday",
        workout: "Upper A",
        selectable: true,
        defaultNext: true,
        items: [
          "Warmup: Bike or easy walk 5-6 min; skip running if back feels tight",
          "Incline Dumbbell Bench Press: 20 x 12, 22 x 10, 22 x 8-10 easy RPE",
          "Assisted Pull-up: comfortable assist x 8, x 8, x 6-8; no swinging",
          "Chest-Supported Row or Seated Cable Row: light/moderate x 12, x 12, x 10-12",
          "Shoulder Press Machine: 20-25 x 10, x 8, x 6-8 only if pain-free",
          "Flat Bench Press: 20-22 x 8-10, x 6-8",
          "Triceps Pushdown: 17.5 x 10, 17.5 x 10",
          "No loaded carries, heavy bracing, or back-extension work"
        ]
      },
      {
        id: "wednesday-recovery",
        day: "Wednesday",
        workout: "Recovery",
        selectable: false,
        items: [
          "Walk 20-30 min total, split into short walks if needed",
          "Gentle mobility: cat-cow, pelvic tilts, optional easy bird dog",
          "If pain is worse than Tuesday, keep Thursday as recovery too"
        ]
      },
      {
        id: "thursday-lower-rehab",
        day: "Thursday",
        workout: "Lower Rehab",
        selectable: true,
        items: [
          "Only if daily movement is improving and pain stays low",
          "Warmup: Bike or walk 6-8 min",
          "Leg Press: very light 80-120 x 12, x 12, x 12; slow, no grinding",
          "Leg Extension: 35-40 x 12, 40 x 10-12",
          "Seated Leg Curl: 30-35 x 12, 35 x 10-12",
          "Rotary Calf: 35-45 x 12, x 12",
          "Core: McGill curl-up, side plank, bird dog 1-2 easy rounds if pain-free",
          "Skip deadlifts, RDLs, Smith squats, back extensions, hangs, and planks if they provoke the back"
        ]
      },
      {
        id: "friday-recovery",
        day: "Friday",
        workout: "Recovery",
        selectable: false,
        items: [
          "Rest, walk, easy cardio, heat if it helps",
          "No testing heavy hinges yet"
        ]
      },
      {
        id: "saturday-upper-b",
        day: "Saturday",
        workout: "Upper B",
        selectable: true,
        items: [
          "Warmup: Bike or easy walk 5-6 min",
          "Flat Bench Press: 22 x 10-12, 22 x 8-10, 22 x 8 easy RPE",
          "Chest-Supported Row or Cable Row: 80-95 x 12, x 12, x 10-12; strict torso",
          "Lateral Raise: 30 x 12, 30-36 x 10, 30-36 x 8-10",
          "Lat Pulldown: 45-50 x 12, 45-50 x 10, 45-50 x 8-10",
          "Dumbbell Chest Fly: 12-14 x 12, 12-14 x 10-12",
          "Triceps Pushdown: 17.5-20 x 10, x 10",
          "Skip hangs/carries if they create lumbar tension"
        ]
      },
      {
        id: "sunday-optional-lower-rehab",
        day: "Sunday",
        workout: "Optional Lower Rehab",
        selectable: true,
        items: [
          "Do this only if back is clearly improving and next-morning response has been fine",
          "Warmup: Bike or walk 6-8 min",
          "Leg Press: 80-120 x 12, x 12, x 12 easy",
          "Leg Extension: 35-45 x 12, x 10-12",
          "Seated Leg Curl: 30-40 x 12, x 10-12",
          "Rotary Calf: 35-45 x 12, x 12",
          "Core: McGill big 3 easy technique work",
          "Otherwise make Sunday recovery; no deadlifts/back extensions this week"
        ]
      }
    ];

    const hasSelected = weeklyPlan.some((entry) => entry.selectable && entry.id === selectedId);
    return weeklyPlan.map((entry) => ({
      ...entry,
      next: entry.selectable && (hasSelected ? entry.id === selectedId : !!entry.defaultNext)
    }));
  }

  function loadLiveSession() {
    try {
      const raw = localStorage.getItem(getLiveStorageKey());
      if (!raw) return { date: getTodayIso(), workout_name: getCurrentPlanName(), sets: [] };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return { date: getTodayIso(), workout_name: getCurrentPlanName(), sets: [] };
      if (!Array.isArray(parsed.sets)) parsed.sets = [];
      if (!parsed.date) parsed.date = getTodayIso();
      if (!parsed.workout_name) parsed.workout_name = getCurrentPlanName();
      parsed.bodyweight = toNumber(parsed.bodyweight);
      parsed.warmup_run_min = toNumber(parsed.warmup_run_min);
      parsed.cooldown_bike_min = toNumber(parsed.cooldown_bike_min);
      if (typeof parsed.started_at !== "string") parsed.started_at = null;
      if (typeof parsed.ended_at !== "string") parsed.ended_at = null;
      return parsed;
    } catch (err) {
      return { date: getTodayIso(), workout_name: getCurrentPlanName(), sets: [] };
    }
  }

  function saveLiveSession(session) {
    localStorage.setItem(getLiveStorageKey(), JSON.stringify(session));
  }

  function loadNextPlanDone(date = getTodayIso()) {
    try {
      const raw = localStorage.getItem(getNextPlanStorageKey(date));
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function saveNextPlanDone(doneMap, date = getTodayIso()) {
    localStorage.setItem(getNextPlanStorageKey(date), JSON.stringify(doneMap || {}));
  }

  function normalizeLiveSession(session) {
    const normalized = (session && typeof session === "object") ? session : {};
    if (!Array.isArray(normalized.sets)) normalized.sets = [];
    if (!normalized.date) normalized.date = getTodayIso();
    if (!normalized.workout_name) normalized.workout_name = getCurrentPlanName();
    normalized.bodyweight = toNumber(normalized.bodyweight);
    normalized.warmup_run_min = toNumber(normalized.warmup_run_min);
    normalized.cooldown_bike_min = toNumber(normalized.cooldown_bike_min);
    if (typeof normalized.started_at !== "string") normalized.started_at = null;
    if (typeof normalized.ended_at !== "string") normalized.ended_at = null;
    return normalized;
  }

  function getLatestLoggedBodyweight() {
    const workoutsDesc = [...state.workoutsAsc].reverse();
    for (const workout of workoutsDesc) {
      const bodyweight = toNumber(workout && workout.bodyweight);
      if (bodyweight !== null) return bodyweight;
    }
    return null;
  }

  function createNewLiveSession() {
    return {
      date: getTodayIso(),
      workout_name: getCurrentPlanName(),
      bodyweight: getLatestLoggedBodyweight(),
      warmup_run_min: null,
      cooldown_bike_min: null,
      sets: [],
      started_at: null,
      ended_at: null
    };
  }

  function formatClockTime(isoString) {
    if (!isoString) return null;
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  function getSessionDurationMinutes(session) {
    if (!session || !session.started_at) return null;
    const start = new Date(session.started_at);
    const end = session.ended_at ? new Date(session.ended_at) : new Date();
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    const diffMs = Math.max(0, end.getTime() - start.getTime());
    return Math.round(diffMs / 60000);
  }

  function getWorkoutFamily(name) {
    const raw = String(name || "").trim().toLowerCase();
    if (raw.startsWith("upper")) return "Upper";
    if (raw.startsWith("lower")) return "Lower";
    if (raw.startsWith("full")) return "Full Body";
    return "";
  }

  function averageNumbers(values) {
    if (!values.length) return null;
    const total = values.reduce((sum, value) => sum + value, 0);
    return total / values.length;
  }

  function getWorkoutDurationEstimateByName(workoutName) {
    const normalizedWorkoutName = String(workoutName || "").trim();
    const exactDurations = [];
    const familyDurations = [];
    const family = getWorkoutFamily(normalizedWorkoutName);

    state.workoutsAsc.forEach((workout) => {
      const duration = getWorkoutDurationMinutes(workout);
      if (duration === null) return;
      const pastName = String(workout.workout_name || "").trim();
      if (normalizedWorkoutName && pastName.toLowerCase() === normalizedWorkoutName.toLowerCase()) {
        exactDurations.push(duration);
        return;
      }
      if (family && getWorkoutFamily(pastName) === family) {
        familyDurations.push(duration);
      }
    });

    const exactAverage = averageNumbers(exactDurations);
    if (exactAverage !== null) {
      return {
        estimateMin: Math.round(exactAverage),
        sourceText: `${exactDurations.length} past ${normalizedWorkoutName || "matching"} session${exactDurations.length === 1 ? "" : "s"}`
      };
    }

    const familyAverage = averageNumbers(familyDurations);
    if (familyAverage !== null) {
      return {
        estimateMin: Math.round(familyAverage),
        sourceText: `${familyDurations.length} past ${family ? family.toLowerCase() : "similar"} workout${familyDurations.length === 1 ? "" : "s"}`
      };
    }

    const overallDurations = state.workoutsAsc
      .map((workout) => getWorkoutDurationMinutes(workout))
      .filter((duration) => duration !== null);
    const overallAverage = averageNumbers(overallDurations);
    if (overallAverage !== null) {
      return {
        estimateMin: Math.round(overallAverage),
        sourceText: `${overallDurations.length} logged workout${overallDurations.length === 1 ? "" : "s"}`
      };
    }

    return null;
  }

  function getLiveWorkoutEstimate(session) {
    return getWorkoutDurationEstimateByName(session && session.workout_name ? session.workout_name : "");
  }

  function renderLiveExerciseOptions() {
    const select = document.getElementById("live-exercise");
    const customWrap = document.getElementById("live-custom-wrap");
    const customInput = document.getElementById("live-custom-exercise");
    if (!select) return;
    const previous = select.value;
    const fromPlan = state.nextPlanExercises || [];
    const unique = [...new Set(fromPlan)].filter(Boolean);
    const options = unique.length ? unique : [];
    options.push("__custom__");

    select.innerHTML = "";
    options.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name === "__custom__" ? "Custom exercise..." : name;
      select.appendChild(option);
    });

    if (options.includes(previous)) select.value = previous;
    else if (unique.length) select.value = unique[0];
    else select.value = "__custom__";

    const isCustom = select.value === "__custom__";
    if (customWrap) {
      customWrap.hidden = !isCustom;
      customWrap.style.display = isCustom ? "" : "none";
    }
    if (customInput && !isCustom) customInput.value = "";

    if (state.liveLoggerBound) {
      updateLiveInputMode();
      const activeExercise = getActiveLiveExerciseName();
      renderLiveExerciseHistory(activeExercise);
    }
  }

  function getActiveLiveExerciseName() {
    const select = document.getElementById("live-exercise");
    const customInput = document.getElementById("live-custom-exercise");
    if (!select) return "Exercise";
    if (select.value === "__custom__") {
      const custom = customInput ? customInput.value.trim() : "";
      return custom || "Exercise";
    }
    return select.value || "Exercise";
  }

  function getLiveExerciseInputMode(name) {
    const raw = String(name || "").trim().toLowerCase();
    if (raw === "plank" || raw === "hangs" || raw === "hang") return "duration-only";
    if (raw === "farmer's carry" || raw === "farmers carry") return "weighted-duration";
    return "standard";
  }

  function updateLiveInputMode() {
    const weightWrap = document.getElementById("live-weight-wrap");
    const repsWrap = document.getElementById("live-reps-wrap");
    const weightInput = document.getElementById("live-weight");
    const repsInput = document.getElementById("live-reps");
    const durationWrap = document.getElementById("live-duration-wrap");
    const durationInput = document.getElementById("live-duration-sec");
    if (!weightWrap || !repsWrap || !weightInput || !repsInput || !durationWrap || !durationInput) return;

    const inputMode = getLiveExerciseInputMode(getActiveLiveExerciseName());
    const durationOnly = inputMode === "duration-only";
    const usesDuration = durationOnly || inputMode === "weighted-duration";
    weightWrap.hidden = durationOnly;
    repsWrap.hidden = usesDuration;
    weightWrap.style.display = durationOnly ? "none" : "";
    repsWrap.style.display = usesDuration ? "none" : "";
    durationWrap.hidden = !usesDuration;
    durationWrap.style.display = usesDuration ? "" : "none";

    if (usesDuration) {
      if (durationOnly) weightInput.value = "";
      repsInput.value = "";
    } else {
      durationInput.value = "";
    }
  }

  function renderLiveExerciseHistory(exerciseName) {
    const box = document.getElementById("live-ex-history");
    if (!box) return;
    if (!exerciseName) {
      box.textContent = "Select an exercise to see recent history.";
      return;
    }

    const target = canonicalExerciseName(exerciseName);
    const rows = [];
    const workoutsDesc = [...state.workoutsAsc].reverse();

    workoutsDesc.forEach((workout) => {
      const exercises = Array.isArray(workout.exercises) ? workout.exercises : [];
      exercises.forEach((exercise) => {
        if (canonicalExerciseName(exercise.name) !== target) return;
        const sets = Array.isArray(exercise.sets) ? exercise.sets : [];
        const setLine = sets.map(formatSet).join(" | ") || "not logged";
        rows.push({
          date: workout.date,
          setLine
        });
      });
    });

    const recent = rows.slice(0, 5);
    if (!recent.length) {
      box.innerHTML = `<p class="live-ex-history-title">Recent ${escapeHtml(exerciseName)}</p><p class="live-ex-history-row">No previous logs yet.</p>`;
      return;
    }

    const items = recent
      .map((row) => `<p class="live-ex-history-row"><strong>${escapeHtml(row.date)}:</strong> ${escapeHtml(row.setLine)}</p>`)
      .join("");

    box.innerHTML = `
      <p class="live-ex-history-title">Recent ${escapeHtml(exerciseName)}</p>
      ${items}
    `;
  }

  function renderLiveSession(session) {
    const nextWorkoutTitle = document.getElementById("next-workout-title");
    const status = document.getElementById("live-status");
    const estimate = document.getElementById("live-estimate");
    const list = document.getElementById("live-list");
    const bodyweightInput = document.getElementById("live-bodyweight");
    const warmupRunInput = document.getElementById("live-warmup-run");
    const cooldownBikeInput = document.getElementById("live-cooldown-bike");
    if (!status || !list) return;

    if (nextWorkoutTitle) {
      nextWorkoutTitle.textContent = `Next Workout: ${session.workout_name || getCurrentPlanName()}`;
    }
    if (bodyweightInput) {
      const nextValue = session.bodyweight === null ? "" : String(session.bodyweight);
      if (document.activeElement !== bodyweightInput || bodyweightInput.value !== nextValue) {
        bodyweightInput.value = nextValue;
      }
    }
    if (warmupRunInput) {
      const nextValue = session.warmup_run_min === null ? "" : String(session.warmup_run_min);
      if (document.activeElement !== warmupRunInput || warmupRunInput.value !== nextValue) {
        warmupRunInput.value = nextValue;
      }
    }
    if (cooldownBikeInput) {
      const nextValue = session.cooldown_bike_min === null ? "" : String(session.cooldown_bike_min);
      if (document.activeElement !== cooldownBikeInput || cooldownBikeInput.value !== nextValue) {
        cooldownBikeInput.value = nextValue;
      }
    }
    const durationMin = getSessionDurationMinutes(session);
    const started = formatClockTime(session.started_at);
    const ended = formatClockTime(session.ended_at);
    const timeText = durationMin === null ? "timer not started" : `${durationMin} min`;
    const startedText = started ? ` | start ${started}` : "";
    const endedText = ended ? ` | end ${ended}` : "";
    status.textContent = `${session.date} | ${session.sets.length} set${session.sets.length === 1 ? "" : "s"} logged | ${timeText}${startedText}${endedText}`;
    if (estimate) {
      const workoutEstimate = getLiveWorkoutEstimate(session);
      if (!workoutEstimate) {
        estimate.textContent = "";
      } else {
        const base = `Estimated total: about ${workoutEstimate.estimateMin} min, based on ${workoutEstimate.sourceText}.`;
        if (durationMin === null) {
          estimate.textContent = base;
        } else {
          const remaining = workoutEstimate.estimateMin - durationMin;
          if (remaining > 0) {
            estimate.textContent = `${base} About ${remaining} min left if today follows the usual pattern.`;
          } else if (remaining < 0) {
            estimate.textContent = `${base} You're about ${Math.abs(remaining)} min past the usual duration.`;
          } else {
            estimate.textContent = `${base} You're right around the usual finish time.`;
          }
        }
      }
    }
    updateLiveToggleButton(session);

    if (!session.sets.length) {
      list.innerHTML = `<div class="live-item">No sets logged yet.</div>`;
      return;
    }

    const grouped = new Map();
    session.sets.forEach((set, index) => {
      const key = set.exercise || "Exercise";
      if (!grouped.has(key)) grouped.set(key, { sets: [], lastIndex: index });
      const entry = grouped.get(key);
      entry.sets.push(set);
      entry.lastIndex = index;
    });

    const html = Array.from(grouped.entries())
      .sort((a, b) => b[1].lastIndex - a[1].lastIndex)
      .map(([exercise, entry]) => {
      const line = entry.sets.map(formatSet).join(" | ");
      return `
        <div class="live-item">
          <div class="live-item-name">${escapeHtml(exercise)}</div>
          <div class="live-item-sets">${escapeHtml(line)}</div>
        </div>
      `;
    }).join("");

    list.innerHTML = html;
  }

  function updateLiveToggleButton(session) {
    const btn = document.getElementById("live-toggle-workout");
    if (!btn) return;
    const running = !!session?.started_at && !session?.ended_at;
    btn.textContent = running ? "End Workout" : "Start Workout";
    btn.classList.toggle("live-btn-start", !running);
    btn.classList.toggle("live-btn-end", running);
  }

  function bindLiveLogger() {
    if (state.liveLoggerBound) return;

    const toggleWorkoutBtn = document.getElementById("live-toggle-workout");
    const addBtn = document.getElementById("live-add");
    const removeLastBtn = document.getElementById("live-remove-last");
    const clearBtn = document.getElementById("live-clear");
    const exportBtn = document.getElementById("live-export-yaml");
    const copyBtn = document.getElementById("live-copy-yaml");
    const exerciseSelect = document.getElementById("live-exercise");
    const customWrap = document.getElementById("live-custom-wrap");
    const customExerciseInput = document.getElementById("live-custom-exercise");
    const bodyweightInput = document.getElementById("live-bodyweight");
    const warmupRunInput = document.getElementById("live-warmup-run");
    const cooldownBikeInput = document.getElementById("live-cooldown-bike");
    const weightInput = document.getElementById("live-weight");
    const repsInput = document.getElementById("live-reps");
    const durationInput = document.getElementById("live-duration-sec");
    const noteInput = document.getElementById("live-set-note");
    const yamlOutput = document.getElementById("live-yaml-output");
    const status = document.getElementById("live-status");
    const feedback = document.getElementById("live-feedback");
    if (!toggleWorkoutBtn || !addBtn || !removeLastBtn || !clearBtn || !exportBtn || !copyBtn || !exerciseSelect || !customWrap || !customExerciseInput || !bodyweightInput || !warmupRunInput || !cooldownBikeInput || !weightInput || !repsInput || !durationInput || !noteInput || !yamlOutput || !status || !feedback) return;

    let session = normalizeLiveSession(loadLiveSession());
    renderLiveExerciseOptions();
    updateLiveInputMode();
    renderLiveSession(session);
    refreshLiveYamlOutput(session);
    renderLiveExerciseHistory(getActiveLiveExerciseName());

    const syncTimer = () => {
      const running = !!session.started_at && !session.ended_at;
      if (running && !state.liveTimerIntervalId) {
        state.liveTimerIntervalId = window.setInterval(() => {
          renderLiveSession(session);
        }, 1000);
      }
      if (!running && state.liveTimerIntervalId) {
        window.clearInterval(state.liveTimerIntervalId);
        state.liveTimerIntervalId = null;
      }
    };
    syncTimer();

    exerciseSelect.addEventListener("change", () => {
      const isCustom = exerciseSelect.value === "__custom__";
      customWrap.hidden = !isCustom;
      customWrap.style.display = isCustom ? "" : "none";
      if (!isCustom) customExerciseInput.value = "";
      updateLiveInputMode();
      renderLiveExerciseHistory(getActiveLiveExerciseName());
    });

    customExerciseInput.addEventListener("input", () => {
      updateLiveInputMode();
      renderLiveExerciseHistory(getActiveLiveExerciseName());
    });

    bodyweightInput.addEventListener("input", () => {
      session = normalizeLiveSession(session);
      session.bodyweight = toNumber(bodyweightInput.value);
      saveLiveSession(session);
      refreshLiveYamlOutput(session);
      queueSharedWorkoutDraftSave(session, feedback);
    });

    warmupRunInput.addEventListener("input", () => {
      session = normalizeLiveSession(session);
      session.warmup_run_min = toNumber(warmupRunInput.value);
      saveLiveSession(session);
      refreshLiveYamlOutput(session);
      queueSharedWorkoutDraftSave(session, feedback);
    });

    cooldownBikeInput.addEventListener("input", () => {
      session = normalizeLiveSession(session);
      session.cooldown_bike_min = toNumber(cooldownBikeInput.value);
      saveLiveSession(session);
      refreshLiveYamlOutput(session);
      queueSharedWorkoutDraftSave(session, feedback);
    });

    toggleWorkoutBtn.addEventListener("click", async () => {
      const running = !!session.started_at && !session.ended_at;
      if (running) {
        session.ended_at = toMinuteStamp();
        feedback.textContent = "Workout timer ended.";
      } else {
        session = createNewLiveSession();
        session.started_at = toMinuteStamp();
        session.ended_at = null;
        feedback.textContent = "Workout timer started.";
      }
      saveLiveSession(session);
      renderLiveSession(session);
      refreshLiveYamlOutput(session);
      syncTimer();
      if (running) {
        feedback.textContent = "Workout timer ended. Saving shared draft...";
        dispatchKeepaliveSharedDraftSave(buildSharedDraftSavePayload(session));
        toggleWorkoutBtn.disabled = true;
        try {
          await flushSharedWorkoutDraftSave(session, feedback, { keepalive: true });
        } finally {
          toggleWorkoutBtn.disabled = false;
        }
      } else {
        queueSharedWorkoutDraftSave(session, feedback);
      }
    });

    addBtn.addEventListener("click", () => {
      const exercise = getActiveLiveExerciseName();
      const inputMode = getLiveExerciseInputMode(exercise);
      const durationOnly = inputMode === "duration-only";
      const usesDuration = durationOnly || inputMode === "weighted-duration";
      const weight = toNumber(weightInput.value);
      const reps = toNumber(repsInput.value);
      const durationSec = toNumber(durationInput.value);
      const note = noteInput.value.trim();
      if (usesDuration) {
        if (durationSec === null) return;
        if (!durationOnly && weight === null) return;
      } else if (weight === null && reps === null) {
        return;
      }

      session = normalizeLiveSession(session);
      session.sets.push({
        exercise,
        weight_kg: durationOnly ? null : weight,
        reps: usesDuration ? null : reps,
        duration_sec: usesDuration ? durationSec : null,
        note: note || null
      });
      saveLiveSession(session);
      renderLiveSession(session);
      refreshLiveYamlOutput(session);
      queueSharedWorkoutDraftSave(session, feedback);
      renderLiveExerciseHistory(exercise);
      durationInput.value = "";
      repsInput.value = "";
      noteInput.value = "";
      if (usesDuration) durationInput.focus();
      else repsInput.focus();
      feedback.textContent = "";
    });

    removeLastBtn.addEventListener("click", () => {
      session = normalizeLiveSession(session);
      if (!session.sets.length) {
        feedback.textContent = "No sets to remove.";
        return;
      }
      const removed = session.sets.pop();
      saveLiveSession(session);
      renderLiveSession(session);
      refreshLiveYamlOutput(session);
      queueSharedWorkoutDraftSave(session, feedback);
      renderLiveExerciseHistory(getActiveLiveExerciseName());
      feedback.textContent = `Removed last set (${removed.exercise || "Exercise"}).`;
    });

    clearBtn.addEventListener("click", () => {
      session = createNewLiveSession();
      saveLiveSession(session);
      renderLiveSession(session);
      bodyweightInput.value = "";
      warmupRunInput.value = "";
      cooldownBikeInput.value = "";
      weightInput.value = "";
      repsInput.value = "";
      durationInput.value = "";
      noteInput.value = "";
      refreshLiveYamlOutput(session);
      feedback.textContent = "Session cleared.";
      queueSharedWorkoutDraftSave(session, feedback);
      syncTimer();
    });

    exportBtn.addEventListener("click", () => {
      yamlOutput.value = refreshLiveYamlOutput(session);
      yamlOutput.scrollTop = 0;
      feedback.textContent = "YAML generated. Tap Copy YAML to copy it.";
    });

    copyBtn.addEventListener("click", async () => {
      const text = yamlOutput.value.trim();
      if (!text) {
        feedback.textContent = "Generate YAML first.";
        return;
      }

      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          yamlOutput.focus();
          yamlOutput.select();
          document.execCommand("copy");
        }
        feedback.textContent = "YAML copied to clipboard.";
      } catch (err) {
        feedback.textContent = "Could not copy automatically. Select and copy manually.";
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "hidden") return;
      const latestSession = normalizeLiveSession(loadLiveSession());
      if (hasLiveSessionProgress(latestSession)) {
        dispatchKeepaliveSharedDraftSave(buildSharedDraftSavePayload(latestSession));
        return;
      }
      const pending = loadPendingSharedDraftSave();
      if (!pending) return;
      dispatchKeepaliveSharedDraftSave(pending);
    });

    window.addEventListener("pagehide", () => {
      const latestSession = normalizeLiveSession(loadLiveSession());
      if (hasLiveSessionProgress(latestSession)) {
        dispatchKeepaliveSharedDraftSave(buildSharedDraftSavePayload(latestSession));
        return;
      }
      const pending = loadPendingSharedDraftSave();
      if (!pending) return;
      dispatchKeepaliveSharedDraftSave(pending);
    });

    void resumePendingSharedDraftSave(feedback);

    state.liveLoggerBound = true;
  }

  function syncActiveWorkoutUi() {
    const session = normalizeLiveSession(loadLiveSession());
    if (!hasLiveSessionProgress(session)) {
      session.workout_name = getCurrentPlanName();
    }
    saveLiveSession(session);
    renderNextPlan(state.workoutsAsc);

    if (!state.liveLoggerBound) return;

    const feedback = document.getElementById("live-feedback");
    renderLiveExerciseOptions();
    updateLiveInputMode();
    renderLiveSession(session);
    refreshLiveYamlOutput(session);
    renderLiveExerciseHistory(getActiveLiveExerciseName());
    if (feedback) {
      feedback.textContent = `Active workout set to ${session.workout_name}.`;
      queueSharedWorkoutDraftSave(session, feedback);
    }
  }

  function bindNextPlanActions() {
    if (state.nextPlanBound) return;
    const overview = document.getElementById("week-overview");
    if (!overview) return;

    overview.addEventListener("click", (event) => {
      const button = event.target.closest("[data-set-active-workout]");
      if (!button) return;

      const planId = button.getAttribute("data-set-active-workout");
      if (!planId) return;

      saveActivePlanId(planId);
      syncActiveWorkoutUi();
    });

    state.nextPlanBound = true;
  }

  function yamlQuote(value) {
    return `'${String(value || "").replaceAll("'", "''")}'`;
  }

  function buildLiveSessionYaml(session) {
    const safeSession = normalizeLiveSession(session || { date: getTodayIso(), workout_name: "", sets: [] });
    const grouped = [];
    const byExercise = new Map();

    safeSession.sets.forEach((set) => {
      const name = String(set.exercise || "Exercise");
      if (!byExercise.has(name)) {
        const entry = { name, sets: [] };
        byExercise.set(name, entry);
        grouped.push(entry);
      }
      byExercise.get(name).sets.push({
        weight_kg: toNumber(set.weight_kg),
        reps: toNumber(set.reps),
        duration_sec: toNumber(set.duration_sec),
        note: (set && typeof set.note === "string" && set.note.trim()) ? set.note.trim() : null
      });
    });

    const lines = [];
    lines.push(`- date: ${yamlQuote(safeSession.date || getTodayIso())}`);
    lines.push(`  workout_name: ${yamlQuote(safeSession.workout_name || "Workout")}`);
    lines.push(`  started_at: ${safeSession.started_at ? yamlQuote(safeSession.started_at) : "null"}`);
    lines.push(`  ended_at: ${safeSession.ended_at ? yamlQuote(safeSession.ended_at) : "null"}`);
    lines.push(`  duration_min: ${getSessionDurationMinutes(safeSession) ?? "null"}`);
    lines.push(`  bodyweight: ${safeSession.bodyweight === null ? "" : safeSession.bodyweight}`);
    lines.push("  energy:");
    lines.push("  notes: null");
    if (safeSession.warmup_run_min === null) {
      lines.push("  warmup: []");
    } else {
      lines.push("  warmup:");
      lines.push(`  - activity: ${yamlQuote("Run")}`);
      lines.push(`    duration_min: ${safeSession.warmup_run_min}`);
    }
    lines.push("  exercises:");

    if (!grouped.length) {
      lines.push("  - name: 'Exercise'");
      lines.push("    sets:");
      lines.push("    - reps: 0");
      return lines.join("\n");
    }

    grouped.forEach((exercise) => {
      lines.push(`  - name: ${yamlQuote(exercise.name)}`);
      lines.push("    sets:");
      exercise.sets.forEach((set) => {
        const hasWeight = set.weight_kg !== null;
        const hasReps = set.reps !== null;
        const hasDuration = set.duration_sec !== null;
        if (hasWeight) lines.push(`    - weight_kg: ${set.weight_kg}`);
        else lines.push("    -");
        if (hasDuration) lines.push(`      duration_sec: ${set.duration_sec}`);
        else if (hasReps) lines.push(`      reps: ${set.reps}`);
        else lines.push("      reps: null");
        if (set.note) lines.push(`      note: ${yamlQuote(set.note)}`);
      });
    });

    if (safeSession.cooldown_bike_min === null) {
      return lines.join("\n");
    }

    lines.push("  cooldown:");
    lines.push(`  - activity: ${yamlQuote("Bike")}`);
    lines.push(`    duration_min: ${safeSession.cooldown_bike_min}`);
    return lines.join("\n");
  }

  function isLowerBodyExercise(name) {
    const raw = String(name || "").toLowerCase();
    return raw.includes("squat") || raw.includes("leg") || raw.includes("calf");
  }

  function buildExerciseHistory(workoutsAsc) {
    const history = new Map();

    workoutsAsc.forEach((workout) => {
      const exercises = Array.isArray(workout.exercises) ? workout.exercises : [];
      exercises.forEach((exercise) => {
        const key = canonicalExerciseName(exercise.name);
        const sets = Array.isArray(exercise.sets) ? exercise.sets : [];
        const weighted = sets
          .map((set) => ({ weight: toNumber(set.weight_kg), reps: toNumber(set.reps) }))
          .filter((set) => set.weight !== null && set.reps !== null);

        const repOnly = sets.map((set) => toNumber(set.reps)).filter((v) => v !== null);
        const topWeightedSet = weighted.reduce((best, curr) => {
          if (!best) return curr;
          if (curr.weight > best.weight) return curr;
          if (curr.weight === best.weight && curr.reps > best.reps) return curr;
          return best;
        }, null);

        const entry = {
          date: String(workout.date),
          exerciseName: exercise.name || key,
          setCount: sets.length,
          topWeight: topWeightedSet ? topWeightedSet.weight : null,
          topReps: topWeightedSet ? topWeightedSet.reps : (repOnly.length ? Math.max(...repOnly) : null)
        };

        if (!history.has(key)) history.set(key, []);
        history.get(key).push(entry);
      });
    });

    return history;
  }

  function average(values) {
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function renderNextPlan(workoutsAsc) {
    const weeklyPlan = getWeeklyPlan();
    const planMetaText = getWeeklyPlanMetaText();

    const nextWorkout = weeklyPlan.find((entry) => entry.next) || weeklyPlan[0];
    const overview = document.getElementById("week-overview");
    const overviewMeta = document.getElementById("week-plan-meta");
    const nextPlanMeta = document.getElementById("next-plan-meta");
    if (overviewMeta) overviewMeta.textContent = planMetaText;
    if (nextPlanMeta) nextPlanMeta.textContent = planMetaText;
    if (overview) {
      overview.innerHTML = weeklyPlan.map((entry) => {
        const nextClass = entry.next ? " week-overview-item is-next-workout" : " week-overview-item";
        const action = !entry.selectable
          ? ""
          : entry.next
            ? '<button class="next-plan-action is-active" type="button" disabled>Active</button>'
            : `<button class="next-plan-action" type="button" data-set-active-workout="${escapeHtml(entry.id)}">Set Active</button>`;
        const estimate = entry.selectable ? getWorkoutDurationEstimateByName(entry.workout) : null;
        const items = entry.items
          .map((item) => `<div class="next-plan-target">${escapeHtml(item)}</div>`)
          .join("");

        return `
        <article class="${nextClass}">
          <div class="week-overview-head">
            <div class="next-plan-name">${escapeHtml(entry.day)}: ${escapeHtml(entry.workout)}</div>
            <div class="week-overview-side">
              ${action}
              ${estimate ? `<div class="week-overview-estimate">~${estimate.estimateMin} min</div>` : ""}
            </div>
          </div>
          <div class="next-plan-copy">
            ${items}
          </div>
        </article>
      `;
      }).join("");
    }

    const nextTitle = document.getElementById("next-workout-title");
    if (nextTitle && nextWorkout) {
      nextTitle.textContent = `Next Workout: ${nextWorkout.workout}`;
    }

    state.nextPlanExercises = (nextWorkout ? nextWorkout.items : [])
      .flatMap((item) => expandPlanExerciseNames(item.split(":")[0].trim()))
      .filter((name) => !["Warmup", "Cooldown", "Optional bike"].includes(name));
    renderLiveExerciseOptions();
    state.nextPlanDone = loadNextPlanDone();

    const container = document.getElementById("next-plan");
    if (!container) return;

    const blocks = (nextWorkout ? nextWorkout.items : []).map((item) => {
      const parts = item.split(":");
      const name = parts.shift().trim();
      const target = parts.join(":").trim();
      const done = !!state.nextPlanDone[name];
      const doneClass = done ? " is-done" : "";
      const checked = done ? "true" : "false";
      return `
      <button class="next-plan-item next-plan-toggle${doneClass}" type="button" data-plan-name="${escapeHtml(name)}" aria-pressed="${checked}">
        <div class="next-plan-check" aria-hidden="true">${done ? "✓" : ""}</div>
        <div class="next-plan-copy">
          <div class="next-plan-name">${escapeHtml(name)}</div>
          <div class="next-plan-target">${escapeHtml(target)}</div>
        </div>
      </button>
    `;
    }).join("");

    container.innerHTML = blocks;

    container.querySelectorAll(".next-plan-toggle").forEach((button) => {
      button.addEventListener("click", () => {
        const name = button.getAttribute("data-plan-name");
        if (!name) return;
        state.nextPlanDone[name] = !state.nextPlanDone[name];
        saveNextPlanDone(state.nextPlanDone);
        renderNextPlan(workoutsAsc);
      });
    });
  }

  function renderSessionList(workoutsDesc) {
    const container = document.getElementById("session-list");
    if (!container) return;
    container.innerHTML = "";

    workoutsDesc.forEach((workout) => {
      const m = buildWorkoutMetrics(workout);
      const item = document.createElement("article");
      item.className = "session-item";
      const exercises = Array.isArray(workout.exercises) ? workout.exercises : [];
      const exercisesHtml = exercises
        .map((exercise) => {
          const sets = Array.isArray(exercise.sets) ? exercise.sets : [];
          const setsText = sets.map(formatSet).join(" | ");
          return `<p class="session-exercise"><strong>${escapeHtml(exercise.name || "Exercise")}:</strong> ${escapeHtml(setsText || "not logged")}</p>`;
        })
        .join("");

      item.innerHTML = `
        <p class="session-title">${workout.date} - ${workout.workout_name || "Workout"}</p>
        <p class="session-meta">${m.sets} sets | ${m.reps} reps | ${formatDuration(workout)}</p>
        <p class="session-notes"><strong>Warmup:</strong> ${escapeHtml(formatActivities(workout.warmup))}</p>
        <div class="session-workout">${exercisesHtml || "<p class=\"session-exercise\">No exercises logged</p>"}</div>
        <p class="session-notes"><strong>Cooldown:</strong> ${escapeHtml(formatActivities(workout.cooldown))}</p>
        <p class="session-notes"><strong>Notes:</strong> ${escapeHtml(workout.notes || "No notes")}</p>
      `;
      container.appendChild(item);
    });
  }

  function renderExerciseCharts() {
    const container = document.getElementById("exercise-charts");
    if (!container) return;

    const entries = Array.from(state.exerciseSeries.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    container.innerHTML = "";

    entries.forEach(([name, series], index) => {
      if (!series.length) return;
      const card = document.createElement("article");
      card.className = "exercise-card";
      const canvasId = `exercise-chart-${index}`;
      card.innerHTML = `
        <p class="exercise-card-title">${escapeHtml(name)}</p>
        <canvas id="${canvasId}" height="180"></canvas>
      `;
      container.appendChild(card);

      const labels = series.map((p) => formatDateShort(p.date));
      const values = series.map((p) => p.value);
      drawLineChart(document.getElementById(canvasId), labels, values, colors.point);
    });
  }

  function renderExerciseLibrary(workoutsAsc) {
    const container = document.getElementById("exercise-library");
    if (!container) return;

    const library = buildExerciseLibrary(workoutsAsc);
    if (!library.length) {
      container.innerHTML = `<article class="exercise-library-empty">No exercises logged yet.</article>`;
      return;
    }

    container.innerHTML = library.map((exercise) => {
      const aliasText = exercise.aliases.length > 1 ? exercise.aliases.join(" • ") : exercise.aliases[0];
      const topWeight = exercise.topWeight === null ? "No weight yet" : `${exercise.topWeight} kg top load`;
      const topRepOrTime = exercise.topDuration !== null
        ? `${exercise.topDuration}s max hold`
          : exercise.topReps !== null
            ? `${exercise.topReps} max reps`
            : "No rep target yet";
      const visualHtml = exercise.demo
        ? `
          <a class="exercise-demo-link" href="${escapeHtml(exercise.demo.pageUrl)}" target="_blank" rel="noreferrer">
            <img class="exercise-demo-image" src="${escapeHtml(exercise.demo.imageUrl)}" alt="${escapeHtml(exercise.displayName)} demo" loading="lazy" />
            <span class="exercise-demo-badge">Demo</span>
          </a>
        `
        : `
          <div class="exercise-avatar">${escapeHtml(exercise.initials)}</div>
          <div class="exercise-stripes" aria-hidden="true">
            <span></span><span></span><span></span>
          </div>
        `;
      const demoSource = exercise.demo
        ? `<a class="exercise-demo-source" href="${escapeHtml(exercise.demo.pageUrl)}" target="_blank" rel="noreferrer">View demo</a>`
        : `<span class="exercise-demo-source is-muted">Visual tag</span>`;

      return `
        <article class="exercise-library-card" data-group="${escapeHtml(exercise.token)}">
          <div class="exercise-library-visual">
            ${visualHtml}
          </div>
          <div class="exercise-library-body">
            <div class="exercise-library-head">
              <div>
                <p class="exercise-library-name">${escapeHtml(exercise.displayName)}</p>
                <p class="exercise-library-alias">${escapeHtml(aliasText)}</p>
              </div>
              <span class="exercise-category-badge">${escapeHtml(exercise.category)}</span>
            </div>
            <div class="exercise-library-meta">
              ${demoSource}
            </div>
            <div class="exercise-library-stats">
              <div class="exercise-stat">
                <span class="exercise-stat-label">Sessions</span>
                <strong>${exercise.sessions}</strong>
              </div>
              <div class="exercise-stat">
                <span class="exercise-stat-label">Sets</span>
                <strong>${exercise.totalSets}</strong>
              </div>
              <div class="exercise-stat">
                <span class="exercise-stat-label">Last Seen</span>
                <strong>${escapeHtml(exercise.lastDate || "-")}</strong>
              </div>
            </div>
            <div class="exercise-library-notes">
              <span>${escapeHtml(topWeight)}</span>
              <span>${escapeHtml(topRepOrTime)}</span>
            </div>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderCharts() {
    const workoutsAsc = state.workoutsAsc;
    const labels = workoutsAsc.map((w) => formatDateShort(w.date));

    state.dailySeries = buildDailyWorkoutSeries(workoutsAsc);
    if (!state.selectedCalendarDate && state.dailySeries.length) {
      state.selectedCalendarDate = pickDefaultCalendarDate(state.dailySeries);
    }
    const selectedDay = state.dailySeries.find((d) => d.date === state.selectedCalendarDate) || state.dailySeries[0] || null;
    if (selectedDay) state.selectedCalendarDate = selectedDay.date;

    renderActivitySummary(state.dailySeries);
    drawCalendarChart(document.getElementById("calendar-chart"), state.dailySeries);
    renderCalendarLegend(state.dailySeries);
    renderCalendarDayDetail(selectedDay);

    const setsSeries = workoutsAsc.map((w) => buildWorkoutMetrics(w).sets);
    drawBarChart(document.getElementById("sets-chart"), labels, setsSeries);

    let lastKnownBodyweight = null;
    const bodyweightPoints = workoutsAsc
      .map((w) => {
        const current = toNumber(w.bodyweight);
        if (current !== null) lastKnownBodyweight = current;
        return { date: String(w.date), bodyweight: lastKnownBodyweight };
      })
      .filter((p) => p.bodyweight !== null);
    const bodyweightCanvas = document.getElementById("bodyweight-chart");
    if (bodyweightPoints.length) {
      const bwLabels = bodyweightPoints.map((p) => formatDateShort(p.date));
      const bwValues = bodyweightPoints.map((p) => p.bodyweight);
      drawLineChart(bodyweightCanvas, bwLabels, bwValues, colors.bar);
    } else {
      drawCanvasMessage(bodyweightCanvas, "Log bodyweight to see trend.");
    }

    const durationPoints = workoutsAsc
      .map((w) => ({ date: String(w.date), duration: getWorkoutDurationMinutes(w) }))
      .filter((p) => p.duration !== null);
    const durationCanvas = document.getElementById("duration-chart");
    if (durationPoints.length) {
      const durationLabels = durationPoints.map((p) => formatDateShort(p.date));
      const durationValues = durationPoints.map((p) => p.duration);
      drawLineChart(durationCanvas, durationLabels, durationValues, colors.line);
    } else {
      drawCanvasMessage(durationCanvas, "Log workout duration to see trend.");
    }

    renderExerciseCharts();
    renderExerciseLibrary(workoutsAsc);
  }

  async function load() {
    const status = document.getElementById("status");
    const shouldUpdateStatus = !!(status && status.dataset && status.dataset.dynamic === "true");

    try {
      const response = await fetch(`./workouts.json?v=${WORKOUTS_DATA_VERSION}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      const workouts = Array.isArray(data.workouts) ? data.workouts : [];
      if (!workouts.length) throw new Error("No workouts found");

      const workoutsAsc = [...workouts].sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const workoutsDesc = [...workoutsAsc].reverse();

      state.workoutsAsc = workoutsAsc;
      state.exerciseSeries = prepareExerciseSeries(workoutsAsc);

      renderKpis(workoutsAsc);
      renderNextPlan(workoutsAsc);
      bindNextPlanActions();
      bindLiveLogger();
      bindCalendarInteractions();
      renderCharts();
      renderSessionList(workoutsDesc);

      if (shouldUpdateStatus) {
        status.textContent = `Showing ${workouts.length} workouts from ${workoutsAsc[0].date} to ${workoutsAsc[workoutsAsc.length - 1].date}.`;
      }
    } catch (err) {
      if (shouldUpdateStatus) {
        status.textContent = "Could not load workouts.json. Start a local server (for example: python3 -m http.server 8000).";
      }
      console.error(err);
    }
  }

  window.addEventListener("resize", () => {
    if (state.workoutsAsc.length) renderCharts();
  });

  load();
})();
