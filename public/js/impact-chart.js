(() => {
  // Native canvas: no additional client framework, package or CDN dependency.
  window.drawImpactChart = function drawImpactChart(canvas, data) {
    const context = canvas.getContext("2d");
    const width = Math.max(280, canvas.parentElement.clientWidth);
    const height = 360;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const margin = { left: 58, right: 22, top: 54, bottom: 72 };
    const start = Date.parse(data.from),
      end = Date.parse(data.to);
    const max = Math.max(1, ...data.points.map((point) => point.views));
    const plotWidth = width - margin.left - margin.right,
      plotHeight = height - margin.top - margin.bottom;
    const x = (time) =>
      margin.left + ((time - start) / (end - start)) * plotWidth;
    const y = (value) => margin.top + (1 - value / max) * plotHeight;
    // Colors come from the page's CSS variables, so the chart follows the light/dark theme.
    const style = getComputedStyle(canvas);
    const color = (name) => style.getPropertyValue(name).trim();
    context.fillStyle = color("--card");
    context.fillRect(0, 0, width, height);
    context.font = "12px Arial";
    for (let i = 0; i <= 4; i++) {
      const value = (max * i) / 4;
      context.strokeStyle = color("--rule");
      context.beginPath();
      context.moveTo(margin.left, y(value));
      context.lineTo(width - margin.right, y(value));
      context.stroke();
      context.fillStyle = color("--muted");
      context.textAlign = "right";
      context.fillText(
        value.toLocaleString("en-US", { maximumFractionDigits: 1 }),
        margin.left - 8,
        y(value) + 4,
      );
    }
    const ticks = width < 500 ? 2 : 4;
    for (let i = 0; i <= ticks; i++) {
      const time = start + ((end - start) * i) / ticks;
      const date = new Date(time).toISOString();
      context.fillStyle = color("--muted");
      context.textAlign = i === 0 ? "left" : i === ticks ? "right" : "center";
      context.fillText(date.slice(5, 10), x(time), height - 38);
      context.fillText(date.slice(11, 16) + " UTC", x(time), height - 20);
    }
    context.strokeStyle = color("--chart-line");
    context.lineWidth = 2;
    context.beginPath();
    data.points.forEach((point, index) => {
      const px = x(Date.parse(point.at));
      if (!index) context.moveTo(px, y(point.views));
      else context.lineTo(px, y(point.views));
    });
    context.stroke();
    for (const [index, event] of data.markers.entries()) {
      const px = x(Date.parse(event.at));
      context.strokeStyle = color(
        event.first ? "--chart-first" : "--chart-update",
      );
      context.setLineDash([5, 4]);
      context.beginPath();
      context.moveTo(px, margin.top);
      context.lineTo(px, height - margin.bottom);
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = color(
        event.first ? "--chart-first" : "--chart-update",
      );
      context.textAlign = px > width - 90 ? "right" : "left";
      context.fillText(
        event.first ? "First publish" : `Update ${event.version - 1}`,
        px,
        17 + (index % 3) * 15,
      );
    }
    canvas.onmousemove = (event) => {
      const rect = canvas.getBoundingClientRect();
      const fraction = (event.clientX - rect.left - margin.left) / plotWidth;
      const index = Math.max(
        0,
        Math.min(
          data.points.length - 1,
          Math.floor(fraction * data.points.length),
        ),
      );
      const point = data.points[index];
      document.getElementById("impact-hover").textContent =
        `${point.at.replace("T", " ").replace(".000Z", " UTC")}: ${point.views} views`;
    };
  };
})();
