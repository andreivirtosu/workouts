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
    exerciseSeries: new Map()
  };

  function toNumber(value) {
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
    const width = Math.max(320, canvas.clientWidth);
    const height = canvas.height;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width, height };
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
    ctx.fillText(String(Math.round(maxV)), 6, pad.top + 4);
    ctx.fillText(String(Math.round(minV)), 6, height - pad.bottom);

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
    labels.forEach((label, i) => {
      const x = pad.left + i * slotW + slotW / 2;
      ctx.fillText(label, x, height - 10);
    });
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

  function renderCharts() {
    const workoutsAsc = state.workoutsAsc;
    const labels = workoutsAsc.map((w) => formatDateShort(w.date));

    const tonnageSeries = workoutsAsc.map((w) => buildWorkoutMetrics(w).tonnage);
    drawLineChart(document.getElementById("tonnage-chart"), labels, tonnageSeries, colors.line);

    const setsSeries = workoutsAsc.map((w) => buildWorkoutMetrics(w).sets);
    drawBarChart(document.getElementById("sets-chart"), labels, setsSeries);

    const select = document.getElementById("exercise-select");
    const selected = select.value || select.options[0]?.value;
    if (!selected) return;

    const series = state.exerciseSeries.get(selected) || [];
    const exLabels = series.map((p) => formatDateShort(p.date));
    const exValues = series.map((p) => p.value);
    drawLineChart(document.getElementById("exercise-chart"), exLabels, exValues, colors.point);
  }

  function renderExerciseSelect() {
    const select = document.getElementById("exercise-select");
    const names = Array.from(state.exerciseSeries.keys()).sort();

    select.innerHTML = "";
    names.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });

    select.addEventListener("change", renderCharts);
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
      renderExerciseSelect();
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
