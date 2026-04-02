const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

function drawIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const s = size; // shorthand

  // Dark rounded rectangle background
  const radius = s * 0.22;
  ctx.fillStyle = '#1a1a2e';
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(s - radius, 0);
  ctx.quadraticCurveTo(s, 0, s, radius);
  ctx.lineTo(s, s - radius);
  ctx.quadraticCurveTo(s, s, s - radius, s);
  ctx.lineTo(radius, s);
  ctx.quadraticCurveTo(0, s, 0, s - radius);
  ctx.lineTo(0, radius);
  ctx.quadraticCurveTo(0, 0, radius, 0);
  ctx.closePath();
  ctx.fill();

  // Audio waveform: 3 vertical bars, teal
  ctx.fillStyle = '#14b8a6';
  ctx.lineCap = 'round';

  const barWidth = s * 0.12;
  const gap = s * 0.08;
  const totalWidth = barWidth * 3 + gap * 2;
  const startX = (s - totalWidth) / 2;
  const centerY = s / 2;
  const barRadius = barWidth / 2;

  // Heights for 3 bars (left short, center tall, right medium)
  const heights = [s * 0.28, s * 0.48, s * 0.34];

  heights.forEach((h, i) => {
    const x = startX + i * (barWidth + gap);
    const y = centerY - h / 2;
    // Rounded rect for each bar
    const r = Math.min(barRadius, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + barWidth - r, y);
    ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + r);
    ctx.lineTo(x + barWidth, y + h - r);
    ctx.quadraticCurveTo(x + barWidth, y + h, x + barWidth - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
  });

  return canvas.toBuffer('image/png');
}

[16, 32, 48, 128].forEach(size => {
  const buf = drawIcon(size);
  const outPath = path.join(__dirname, 'extension', `icon${size}.png`);
  fs.writeFileSync(outPath, buf);
  console.log(`Generated ${outPath} (${buf.length} bytes)`);
});
