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
    liveLoggerBound: false
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
    let tonnage = 0;

    exercises.forEach((ex) => {
      const exSets = Array.isArray(ex.sets) ? ex.sets : [];
      sets += exSets.length;

      exSets.forEach((set) => {
        const setReps = toNumber(set.reps);
        const setWeight = toNumber(set.weight_kg);

        if (setReps !== null) reps += setReps;
        if (setReps !== null && setWeight !== null) tonnage += setWeight * setReps;
      });
    });

    return { sets, reps, tonnage };
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
        acc.tonnage += m.tonnage;
        return acc;
      },
      { sets: 0, reps: 0, tonnage: 0 }
    );

    document.getElementById("kpi-workouts").textContent = String(workoutsAsc.length);
    document.getElementById("kpi-sets").textContent = String(totals.sets);
    document.getElementById("kpi-reps").textContent = String(totals.reps);
    document.getElementById("kpi-tonnage").textContent = Math.round(totals.tonnage).toLocaleString();
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

    if (weight !== null && reps !== null) return `${weight}kg x ${reps}`;
    if (reps !== null) return `${reps} reps`;
    if (duration !== null) return `${duration}s`;
    if (weight !== null) return `${weight}kg`;
    return "set logged";
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

  function getTodayIso() {
    return toIsoDate(new Date());
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
    return { date: today, workout_name: "", sets: [] };
  }

  function renderLiveExerciseOptions() {
    const select = document.getElementById("live-exercise");
    if (!select) return;
    const previous = select.value;
    const unique = [...new Set(state.nextPlanExercises)].filter(Boolean);
    const options = unique.length ? unique : ["Custom Exercise"];

    select.innerHTML = "";
    options.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });

    if (options.includes(previous)) select.value = previous;
  }

  function renderLiveSession(session) {
    const status = document.getElementById("live-status");
    const list = document.getElementById("live-list");
    const nameInput = document.getElementById("live-workout-name");
    if (!status || !list || !nameInput) return;

    nameInput.value = session.workout_name || "";
    status.textContent = `${session.date} | ${session.sets.length} set${session.sets.length === 1 ? "" : "s"} logged`;

    if (!session.sets.length) {
      list.innerHTML = `<div class="live-item">No sets logged yet.</div>`;
      return;
    }

    const grouped = new Map();
    session.sets.forEach((set) => {
      const key = set.exercise || "Exercise";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(set);
    });

    const html = Array.from(grouped.entries()).map(([exercise, sets]) => {
      const line = sets.map((s) => {
        const weight = toNumber(s.weight_kg);
        const reps = toNumber(s.reps);
        if (weight !== null && reps !== null) return `${weight}kg x ${reps}`;
        if (reps !== null) return `${reps} reps`;
        if (weight !== null) return `${weight}kg`;
        return "set";
      }).join(" | ");
      return `
        <div class="live-item">
          <div class="live-item-name">${escapeHtml(exercise)}</div>
          <div class="live-item-sets">${escapeHtml(line)}</div>
        </div>
      `;
    }).join("");

    list.innerHTML = html;
  }

  function bindLiveLogger() {
    if (state.liveLoggerBound) return;

    const addBtn = document.getElementById("live-add");
    const clearBtn = document.getElementById("live-clear");
    const exportBtn = document.getElementById("live-export-yaml");
    const copyBtn = document.getElementById("live-copy-yaml");
    const exerciseSelect = document.getElementById("live-exercise");
    const weightInput = document.getElementById("live-weight");
    const repsInput = document.getElementById("live-reps");
    const nameInput = document.getElementById("live-workout-name");
    const yamlOutput = document.getElementById("live-yaml-output");
    if (!addBtn || !clearBtn || !exportBtn || !copyBtn || !exerciseSelect || !weightInput || !repsInput || !nameInput || !yamlOutput) return;

    let session = ensureTodaySession(loadLiveSession());
    renderLiveExerciseOptions();
    renderLiveSession(session);

    nameInput.addEventListener("input", () => {
      session.workout_name = nameInput.value.trim();
      saveLiveSession(session);
    });

    addBtn.addEventListener("click", () => {
      const exercise = exerciseSelect.value || "Exercise";
      const weight = toNumber(weightInput.value);
      const reps = toNumber(repsInput.value);
      if (weight === null && reps === null) return;

      session = ensureTodaySession(session);
      session.sets.push({
        exercise,
        weight_kg: weight,
        reps
      });
      saveLiveSession(session);
      renderLiveSession(session);
      repsInput.value = "";
      repsInput.focus();
    });

    clearBtn.addEventListener("click", () => {
      session = { date: getTodayIso(), workout_name: "", sets: [] };
      saveLiveSession(session);
      renderLiveSession(session);
      weightInput.value = "";
      repsInput.value = "";
      yamlOutput.value = "";
    });

    exportBtn.addEventListener("click", () => {
      yamlOutput.value = buildLiveSessionYaml(session);
      yamlOutput.scrollTop = 0;
      status.textContent = "YAML generated. Tap Copy YAML to copy it.";
    });

    copyBtn.addEventListener("click", async () => {
      const text = yamlOutput.value.trim();
      if (!text) {
        status.textContent = "Generate YAML first.";
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
        status.textContent = "YAML copied to clipboard.";
      } catch (err) {
        status.textContent = "Could not copy automatically. Select and copy manually.";
      }
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
        reps: toNumber(set.reps)
      });
    });

    const lines = [];
    lines.push(`- date: ${yamlQuote(safeSession.date || getTodayIso())}`);
    lines.push(`  workout_name: ${yamlQuote(safeSession.workout_name || "Workout")}`);
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
        if (hasWeight) lines.push(`    - weight_kg: ${set.weight_kg}`);
        else lines.push("    -");
        if (hasReps) lines.push(`      reps: ${set.reps}`);
        else lines.push("      reps: null");
      });
    });

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
    const container = document.getElementById("next-plan");
    if (!container) return;

    const plan = [
      { name: "Warmup", target: "Run 8 min + mobility 5 min" },
      { name: "Smith Machine Squat", target: "5kg x 10, 10kg x 10, 15kg x 8-10, 15kg x 8-10" },
      { name: "Incline Dumbbell Bench Press", target: "16kg x 10-12, 18kg x 8-10, 18kg x 8-10" },
      { name: "Cable Row / Chest Supported Row", target: "65kg x 12-15, 75kg x 10-12, 85kg x 8-10" },
      { name: "Leg Press", target: "150kg x 12, 160kg x 10-12, 165kg x 8-10" },
      { name: "Leg Curl", target: "30kg x 12-15, 35kg x 10-12, 35kg x 10-12" },
      { name: "Shoulder Press Machine", target: "15kg x 12, 20kg x 8-10, 20kg x 8" },
      { name: "Triceps Pushdown + Biceps Curl", target: "2 rounds: 15kg x 10-12 + 12-14kg x 8-10" },
      { name: "Plank", target: "2 sets x 30-45s" },
      { name: "Cooldown", target: "Bike 8-10 min" }
    ];

    state.nextPlanExercises = plan
      .map((item) => item.name)
      .filter((name) => !["Warmup", "Cooldown"].includes(name));

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
    renderLiveExerciseOptions();
  }

  function renderSessionList(workoutsDesc) {
    const container = document.getElementById("session-list");
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
        <p class="session-meta">${m.sets} sets | ${m.reps} reps | ${Math.round(m.tonnage)} kg tonnage</p>
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

    const tonnageSeries = workoutsAsc.map((w) => buildWorkoutMetrics(w).tonnage);
    drawLineChart(document.getElementById("tonnage-chart"), labels, tonnageSeries, colors.line);

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

    renderExerciseCharts();
  }

  async function load() {
    const status = document.getElementById("status");

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

      status.textContent = `Showing ${workouts.length} workouts from ${workoutsAsc[0].date} to ${workoutsAsc[workoutsAsc.length - 1].date}.`;
    } catch (err) {
      status.textContent = "Could not load workouts.json. Start a local server (for example: python3 -m http.server 8000).";
      console.error(err);
    }
  }

  window.addEventListener("resize", () => {
    if (state.workoutsAsc.length) renderCharts();
  });

  load();
})();
