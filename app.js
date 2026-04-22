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
    restTimerIntervalId: null,
    restTimerEndTs: null
  };

  const SHARED_WORKOUT_OBJECT_URL = "https://api.restful-api.dev/objects/ff8081819d82fab6019da7edcb1f2a55";

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

  async function saveSharedWorkoutDraft(text, title) {
    const response = await fetch(SHARED_WORKOUT_OBJECT_URL, {
      method: "PATCH",
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

  function queueSharedWorkoutDraftSave(session, feedbackEl) {
    if (state.sharedDraftSaveTimerId) {
      window.clearTimeout(state.sharedDraftSaveTimerId);
    }

    const yaml = refreshLiveYamlOutput(session);
    state.sharedDraftSaveTimerId = window.setTimeout(async () => {
      state.sharedDraftSaveTimerId = null;
      try {
        await saveSharedWorkoutDraft(yaml, session.workout_name || getCurrentPlanName());
        if (feedbackEl) feedbackEl.textContent = "Shared draft auto-saved.";
      } catch (err) {
        if (feedbackEl) feedbackEl.textContent = err.message || "Could not auto-save shared draft.";
      }
    }, 700);
  }

  function toNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" && value.trim() === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function parseDate(dateStr) {
    return new Date(`${dateStr}T00:00:00`);
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
    if (raw.includes("machine chest press") || raw === "chest press") return "Machine Chest Press";
    if (raw.includes("chest supported row") || raw.includes("cable row") || raw.includes("seated cable row")) return "Row";
    if (raw.includes("lat pulldown")) return "Lat Pulldown";
    if (raw.includes("shoulder press")) return "Shoulder Press";
    if (raw.includes("biceps curl")) return "Biceps Curl";
    if (raw.includes("triceps")) return "Triceps Pushdown";
    if (raw.includes("leg curl")) return "Leg Curl";
    if (raw.includes("back extension")) return "Back Extension";
    if (raw.includes("squat")) return "Squat";
    return name || "Unknown";
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

  function drawCalendarChart(canvas, days) {
    if (!canvas) return;
    const labels = days.map((d) => d.label);
    const values = days.map((d) => d.count);
    const { ctx, width, height } = setupCanvas(canvas);
    const pad = { top: 16, right: 12, bottom: 34, left: 38 };
    ctx.clearRect(0, 0, width, height);

    if (!values.length) return;

    drawAxes(ctx, width, height, { pad });

    const maxV = Math.max(1, ...values);
    const chartW = width - pad.left - pad.right;
    const chartH = height - pad.top - pad.bottom;
    const slotW = chartW / values.length;
    const barW = Math.max(6, slotW * 0.65);
    const bars = [];

    values.forEach((v, i) => {
      const baseH = (v / maxV) * chartH;
      const h = Math.max(4, baseH);
      const x = pad.left + i * slotW + (slotW - barW) / 2;
      const y = height - pad.bottom - h;
      const day = days[i];
      const selected = state.selectedCalendarDate === day.date;

      ctx.fillStyle = v > 0 ? colors.bar : "#d5d9df";
      ctx.fillRect(x, y, barW, h);

      if (selected) {
        ctx.strokeStyle = "#cc5a2b";
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 1, y - 1, barW + 2, h + 2);
      }

      bars.push({ x, y, w: barW, h, day });
    });

    state.calendarBars = bars;

    ctx.fillStyle = colors.text;
    ctx.font = "12px 'Avenir Next', 'Trebuchet MS', sans-serif";
    ctx.textAlign = "center";
    const tickIndexes = labels.length <= 8
      ? labels.map((_, i) => i)
      : [0, Math.floor((labels.length - 1) / 3), Math.floor((labels.length - 1) * 2 / 3), labels.length - 1];

    tickIndexes.forEach((i) => {
      const x = pad.left + i * slotW + slotW / 2;
      ctx.fillText(labels[i], x, height - 10);
    });
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
        id: "monday-upper-a",
        day: "Monday",
        workout: "Upper A",
        selectable: true,
        items: [
          "Warmup: Bike or row 5 min + mobility 3-5 min",
          "Incline Dumbbell Bench Press: 3 x 8-10",
          "Chest Supported Row or Seated Cable Row: 3 x 8-12",
          "Assisted Pull-up: 3 x 5-8",
          "Shoulder Press Machine or DB Shoulder Press: 2-3 x 8-10",
          "Machine Chest Press or Assisted Dips: 2-3 x 8-10",
          "Rear Delt Fly or Lateral Raise: 2 x 12-15",
          "Plank or Dead Bug: 2-3 sets"
        ]
      },
      {
        id: "tuesday-lower-a",
        day: "Tuesday",
        workout: "Lower A",
        selectable: true,
        defaultNext: true,
        items: [
          "Warmup: Easy bike 5 min + lower-body mobility",
          "Smith Machine Squat or Goblet Squat: 3-4 x 8-10",
          "Leg Press: 3 x 10-15",
          "Seated or Lying Leg Curl: 3 x 12-15",
          "Walking Lunges or Split Squat: 2 sets each side",
          "Calf Raise: 2-3 x 12-15",
          "Farmer's Carry: 3-4 rounds",
          "Optional bike: 8-10 min"
        ]
      },
      {
        id: "wednesday-recovery",
        day: "Wednesday",
        workout: "Recovery",
        selectable: false,
        items: [
          "Rest, walk, or easy cardio"
        ]
      },
      {
        id: "thursday-upper-b",
        day: "Thursday",
        workout: "Upper B",
        selectable: true,
        items: [
          "Warmup: Bike or row 5 min + shoulder mobility",
          "Flat DB Bench Press or Machine Chest Press: 3 x 8-10",
          "One-Arm DB Row or Cable Row: 3 x 10-12",
          "Lat Pulldown: 3 x 8-12",
          "Assisted Dips or Incline Machine Press: 2-3 x 8-10",
          "Rear Delt Fly: 2-3 x 12-15",
          "Lateral Raise or Face Pull: 2 x 12-15",
          "Hangs or Pallof Press: 2-3 sets"
        ]
      },
      {
        id: "friday-recovery",
        day: "Friday",
        workout: "Recovery",
        selectable: false,
        items: [
          "Rest, walk, or easy cardio"
        ]
      },
      {
        id: "saturday-lower-b",
        day: "Saturday",
        workout: "Lower B",
        selectable: true,
        items: [
          "Warmup: Easy bike 5 min + hip mobility",
          "Romanian Deadlift: 3 x 8-10",
          "Bulgarian Split Squat or Reverse Lunge: 3 sets each side",
          "Leg Curl: 3 x 12-15",
          "Back Extension: 2-3 x 12-15",
          "Leg Press, lighter than Lower A: 2 x 15",
          "Plank or Dead Bug: 2-3 sets",
          "Bike / rower / incline walk: 10 min steady"
        ]
      },
      {
        id: "sunday-recovery",
        day: "Sunday",
        workout: "Recovery",
        selectable: false,
        items: [
          "Rest or light mobility"
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
      parsed.workout_name = getCurrentPlanName();
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

  function ensureTodaySession(session) {
    const today = getTodayIso();
    if (session.date === today) {
      session.workout_name = getCurrentPlanName();
      session.bodyweight = toNumber(session.bodyweight);
      session.warmup_run_min = toNumber(session.warmup_run_min);
      session.cooldown_bike_min = toNumber(session.cooldown_bike_min);
      return session;
    }
    return {
      date: today,
      workout_name: getCurrentPlanName(),
      bodyweight: null,
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
    const list = document.getElementById("live-list");
    const bodyweightInput = document.getElementById("live-bodyweight");
    const warmupRunInput = document.getElementById("live-warmup-run");
    const cooldownBikeInput = document.getElementById("live-cooldown-bike");
    if (!status || !list) return;

    if (nextWorkoutTitle) {
      nextWorkoutTitle.textContent = `Next Workout: ${session.workout_name || getCurrentPlanName()}`;
    }
    if (bodyweightInput) {
      bodyweightInput.value = session.bodyweight === null ? "" : String(session.bodyweight);
    }
    if (warmupRunInput) {
      warmupRunInput.value = session.warmup_run_min === null ? "" : String(session.warmup_run_min);
    }
    if (cooldownBikeInput) {
      cooldownBikeInput.value = session.cooldown_bike_min === null ? "" : String(session.cooldown_bike_min);
    }
    const durationMin = getSessionDurationMinutes(session);
    const started = formatClockTime(session.started_at);
    const ended = formatClockTime(session.ended_at);
    const timeText = durationMin === null ? "timer not started" : `${durationMin} min`;
    const startedText = started ? ` | start ${started}` : "";
    const endedText = ended ? ` | end ${ended}` : "";
    status.textContent = `${session.date} | ${session.sets.length} set${session.sets.length === 1 ? "" : "s"} logged | ${timeText}${startedText}${endedText}`;
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
    const rest60Btn = document.getElementById("rest-60");
    const rest90Btn = document.getElementById("rest-90");
    const rest120Btn = document.getElementById("rest-120");
    const restStopBtn = document.getElementById("rest-stop");
    if (!toggleWorkoutBtn || !addBtn || !removeLastBtn || !clearBtn || !exportBtn || !copyBtn || !exerciseSelect || !customWrap || !customExerciseInput || !bodyweightInput || !warmupRunInput || !cooldownBikeInput || !weightInput || !repsInput || !durationInput || !noteInput || !yamlOutput || !status || !feedback || !rest60Btn || !rest90Btn || !rest120Btn || !restStopBtn) return;

    let session = ensureTodaySession(loadLiveSession());
    renderLiveExerciseOptions();
    updateLiveInputMode();
    renderLiveSession(session);
    refreshLiveYamlOutput(session);
    renderLiveExerciseHistory(getActiveLiveExerciseName());
    renderRestDisplay("--:--");

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
      session = ensureTodaySession(session);
      session.bodyweight = toNumber(bodyweightInput.value);
      saveLiveSession(session);
      refreshLiveYamlOutput(session);
      queueSharedWorkoutDraftSave(session, feedback);
    });

    warmupRunInput.addEventListener("input", () => {
      session = ensureTodaySession(session);
      session.warmup_run_min = toNumber(warmupRunInput.value);
      saveLiveSession(session);
      refreshLiveYamlOutput(session);
      queueSharedWorkoutDraftSave(session, feedback);
    });

    cooldownBikeInput.addEventListener("input", () => {
      session = ensureTodaySession(session);
      session.cooldown_bike_min = toNumber(cooldownBikeInput.value);
      saveLiveSession(session);
      refreshLiveYamlOutput(session);
      queueSharedWorkoutDraftSave(session, feedback);
    });

    toggleWorkoutBtn.addEventListener("click", () => {
      const running = !!session.started_at && !session.ended_at;
      if (running) {
        session.ended_at = toMinuteStamp();
        feedback.textContent = "Workout timer ended.";
      } else {
        session = ensureTodaySession(session);
        session.started_at = toMinuteStamp();
        session.ended_at = null;
        feedback.textContent = "Workout timer started.";
      }
      saveLiveSession(session);
      renderLiveSession(session);
      refreshLiveYamlOutput(session);
      queueSharedWorkoutDraftSave(session, feedback);
      syncTimer();
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

      session = ensureTodaySession(session);
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
      session = ensureTodaySession(session);
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
      session = {
        date: getTodayIso(),
        workout_name: getCurrentPlanName(),
        bodyweight: null,
        warmup_run_min: null,
        cooldown_bike_min: null,
        sets: [],
        started_at: null,
        ended_at: null
      };
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
      stopRestTimer();
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

    rest60Btn.addEventListener("click", () => {
      startRestTimer(60, feedback);
      feedback.textContent = "Rest timer: 60s";
    });

    rest90Btn.addEventListener("click", () => {
      startRestTimer(90, feedback);
      feedback.textContent = "Rest timer: 90s";
    });

    rest120Btn.addEventListener("click", () => {
      startRestTimer(120, feedback);
      feedback.textContent = "Rest timer: 120s";
    });

    restStopBtn.addEventListener("click", () => {
      stopRestTimer();
      feedback.textContent = "Rest timer stopped.";
    });

    state.liveLoggerBound = true;
  }

  function syncActiveWorkoutUi() {
    const session = ensureTodaySession(loadLiveSession());
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
    const safeSession = ensureTodaySession(session || { date: getTodayIso(), workout_name: "", sets: [] });
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

  function formatRestTime(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }

  function renderRestDisplay(text) {
    const display = document.getElementById("rest-display");
    if (!display) return;
    display.textContent = text;
  }

  function stopRestTimer() {
    if (state.restTimerIntervalId) {
      window.clearInterval(state.restTimerIntervalId);
      state.restTimerIntervalId = null;
    }
    state.restTimerEndTs = null;
    renderRestDisplay("--:--");
  }

  function startRestTimer(seconds, feedbackNode) {
    state.restTimerEndTs = Date.now() + seconds * 1000;
    if (state.restTimerIntervalId) {
      window.clearInterval(state.restTimerIntervalId);
      state.restTimerIntervalId = null;
    }

    const tick = () => {
      if (!state.restTimerEndTs) {
        renderRestDisplay("--:--");
        return;
      }
      const remainingMs = state.restTimerEndTs - Date.now();
      const remainingSec = Math.ceil(remainingMs / 1000);
      if (remainingSec <= 0) {
        renderRestDisplay("00:00");
        if (feedbackNode) feedbackNode.textContent = "Rest finished.";
        if (state.restTimerIntervalId) {
          window.clearInterval(state.restTimerIntervalId);
          state.restTimerIntervalId = null;
        }
        state.restTimerEndTs = null;
        return;
      }
      renderRestDisplay(formatRestTime(remainingSec));
    };

    tick();
    state.restTimerIntervalId = window.setInterval(tick, 250);
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

    const nextWorkout = weeklyPlan.find((entry) => entry.next) || weeklyPlan[0];
    const overview = document.getElementById("week-overview");
    if (overview) {
      overview.innerHTML = weeklyPlan.map((entry) => {
        const nextClass = entry.next ? " week-overview-item is-next-workout" : " week-overview-item";
        const action = !entry.selectable
          ? ""
          : entry.next
            ? '<button class="next-plan-action is-active" type="button" disabled>Active</button>'
            : `<button class="next-plan-action" type="button" data-set-active-workout="${escapeHtml(entry.id)}">Set Active</button>`;
        const items = entry.items
          .map((item) => `<div class="next-plan-target">${escapeHtml(item)}</div>`)
          .join("");

        return `
        <article class="${nextClass}">
          <div class="week-overview-head">
            <div class="next-plan-name">${escapeHtml(entry.day)}: ${escapeHtml(entry.workout)}</div>
            ${action}
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

  function renderCharts() {
    const workoutsAsc = state.workoutsAsc;
    const labels = workoutsAsc.map((w) => formatDateShort(w.date));

    state.dailySeries = buildDailyWorkoutSeries(workoutsAsc);
    if (!state.selectedCalendarDate && state.dailySeries.length) {
      state.selectedCalendarDate = pickDefaultCalendarDate(state.dailySeries);
    }
    const selectedDay = state.dailySeries.find((d) => d.date === state.selectedCalendarDate) || state.dailySeries[0] || null;
    if (selectedDay) state.selectedCalendarDate = selectedDay.date;

    drawCalendarChart(document.getElementById("calendar-chart"), state.dailySeries);
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
  }

  async function load() {
    const status = document.getElementById("status");
    const shouldUpdateStatus = !!(status && status.dataset && status.dataset.dynamic === "true");

    try {
      const response = await fetch("./workouts.json", { cache: "no-store" });
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
