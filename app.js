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
    liveLoggerBound: false,
    liveTimerIntervalId: null,
    restTimerIntervalId: null,
    restTimerEndTs: null
  };

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
      <div><strong>${escapeHtml(day.date)}</strong> (${day.count} workout${day.count > 1 ? "s" : ""})</div>
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

  function loadLiveSession() {
    try {
      const raw = localStorage.getItem(getLiveStorageKey());
      if (!raw) return { date: getTodayIso(), workout_name: "", sets: [] };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return { date: getTodayIso(), workout_name: "", sets: [] };
      if (!Array.isArray(parsed.sets)) parsed.sets = [];
      if (!parsed.date) parsed.date = getTodayIso();
      if (typeof parsed.workout_name !== "string") parsed.workout_name = "";
      if (typeof parsed.started_at !== "string") parsed.started_at = null;
      if (typeof parsed.ended_at !== "string") parsed.ended_at = null;
      return parsed;
    } catch (err) {
      return { date: getTodayIso(), workout_name: "", sets: [] };
    }
  }

  function saveLiveSession(session) {
    localStorage.setItem(getLiveStorageKey(), JSON.stringify(session));
  }

  function ensureTodaySession(session) {
    const today = getTodayIso();
    if (session.date === today) return session;
    return { date: today, workout_name: "", sets: [], started_at: null, ended_at: null };
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

  function isDurationOnlyExercise(name) {
    const raw = String(name || "").trim().toLowerCase();
    return raw === "plank" || raw === "hangs" || raw === "hang";
  }

  function updateLiveInputMode() {
    const weightWrap = document.getElementById("live-weight-wrap");
    const repsWrap = document.getElementById("live-reps-wrap");
    const weightInput = document.getElementById("live-weight");
    const repsInput = document.getElementById("live-reps");
    const durationWrap = document.getElementById("live-duration-wrap");
    const durationInput = document.getElementById("live-duration-sec");
    if (!weightWrap || !repsWrap || !weightInput || !repsInput || !durationWrap || !durationInput) return;

    const durationOnly = isDurationOnlyExercise(getActiveLiveExerciseName());
    weightWrap.hidden = durationOnly;
    repsWrap.hidden = durationOnly;
    weightWrap.style.display = durationOnly ? "none" : "";
    repsWrap.style.display = durationOnly ? "none" : "";
    durationWrap.hidden = !durationOnly;
    durationWrap.style.display = durationOnly ? "" : "none";

    if (durationOnly) {
      weightInput.value = "";
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
    const status = document.getElementById("live-status");
    const list = document.getElementById("live-list");
    const nameInput = document.getElementById("live-workout-name");
    if (!status || !list || !nameInput) return;

    nameInput.value = session.workout_name || "";
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
    const weightInput = document.getElementById("live-weight");
    const repsInput = document.getElementById("live-reps");
    const durationInput = document.getElementById("live-duration-sec");
    const noteInput = document.getElementById("live-set-note");
    const nameInput = document.getElementById("live-workout-name");
    const yamlOutput = document.getElementById("live-yaml-output");
    const status = document.getElementById("live-status");
    const feedback = document.getElementById("live-feedback");
    const rest60Btn = document.getElementById("rest-60");
    const rest90Btn = document.getElementById("rest-90");
    const rest120Btn = document.getElementById("rest-120");
    const restStopBtn = document.getElementById("rest-stop");
    if (!toggleWorkoutBtn || !addBtn || !removeLastBtn || !clearBtn || !exportBtn || !copyBtn || !exerciseSelect || !customWrap || !customExerciseInput || !weightInput || !repsInput || !durationInput || !noteInput || !nameInput || !yamlOutput || !status || !feedback || !rest60Btn || !rest90Btn || !rest120Btn || !restStopBtn) return;

    let session = ensureTodaySession(loadLiveSession());
    renderLiveExerciseOptions();
    updateLiveInputMode();
    renderLiveSession(session);
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

    nameInput.addEventListener("input", () => {
      session.workout_name = nameInput.value.trim();
      saveLiveSession(session);
    });

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
      syncTimer();
    });

    addBtn.addEventListener("click", () => {
      const exercise = getActiveLiveExerciseName();
      const durationOnly = isDurationOnlyExercise(exercise);
      const weight = toNumber(weightInput.value);
      const reps = toNumber(repsInput.value);
      const durationSec = toNumber(durationInput.value);
      const note = noteInput.value.trim();
      if (durationOnly) {
        if (durationSec === null) return;
      } else if (weight === null && reps === null) {
        return;
      }

      session = ensureTodaySession(session);
      session.sets.push({
        exercise,
        weight_kg: durationOnly ? null : weight,
        reps: durationOnly ? null : reps,
        duration_sec: durationOnly ? durationSec : null,
        note: note || null
      });
      saveLiveSession(session);
      renderLiveSession(session);
      renderLiveExerciseHistory(exercise);
      durationInput.value = "";
      repsInput.value = "";
      noteInput.value = "";
      if (durationOnly) durationInput.focus();
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
      renderLiveExerciseHistory(getActiveLiveExerciseName());
      feedback.textContent = `Removed last set (${removed.exercise || "Exercise"}).`;
    });

    clearBtn.addEventListener("click", () => {
      session = { date: getTodayIso(), workout_name: "", sets: [], started_at: null, ended_at: null };
      saveLiveSession(session);
      renderLiveSession(session);
      weightInput.value = "";
      repsInput.value = "";
      durationInput.value = "";
      noteInput.value = "";
      yamlOutput.value = "";
      feedback.textContent = "Session cleared.";
      syncTimer();
      stopRestTimer();
    });

    exportBtn.addEventListener("click", () => {
      yamlOutput.value = buildLiveSessionYaml(session);
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
    lines.push("  bodyweight:");
    lines.push("  energy:");
    lines.push("  notes: null");
    lines.push("  warmup: []");
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
    const plan = [
      { name: "Warmup", target: "Run 6-8 min + mobility 3-5 min" },
      { name: "Leg Press", target: "3 x 12-15" },
      { name: "Romanian Deadlift", target: "3 x 8-10" },
      { name: "Incline Dumbbell Bench Press", target: "3 x 10-12" },
      { name: "Lat Pulldown / Assisted Pull-up", target: "3 x 8-12" },
      { name: "Bulgarian Split Squat", target: "2 x 8-10/leg" },
      { name: "Seated Cable Row", target: "2-3 x 10-12" },
      { name: "Rear Delt Fly / Cable Lateral Raise", target: "2 x 12-15" },
      { name: "Plank", target: "2 x 45-60s" },
      { name: "Cooldown", target: "Bike 5-10 min optional" }
    ];

    state.nextPlanExercises = plan
      .map((item) => item.name)
      .filter((name) => !["Warmup", "Cooldown"].includes(name));
    renderLiveExerciseOptions();

    const container = document.getElementById("next-plan");
    if (!container) return;

    const blocks = plan.map((item) => `
      <div class="next-plan-item">
        <div class="next-plan-name">${escapeHtml(item.name)}</div>
        <div class="next-plan-target">${escapeHtml(item.target)}</div>
      </div>
    `).join("");

    container.innerHTML = `
      <div class="next-plan-head">Manual plan for your next session (${workoutsAsc.length} workouts logged so far).</div>
      ${blocks}
    `;
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
