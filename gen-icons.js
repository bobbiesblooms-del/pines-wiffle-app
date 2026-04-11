// Run once with: node gen-icons.js
const { createCanvas } = require('canvas');
const fs = require('fs');

function makeIcon(size) {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');
  const r = size * 0.12;

  // Background
  ctx.fillStyle = '#0f1117';
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, r);
  ctx.fill();

  // Ball circle
  const cx = size / 2, cy = size / 2, br = size * 0.32;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, br, 0, Math.PI * 2);
  ctx.fill();

  // Stitches
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = size * 0.045;
  ctx.lineCap = 'round';

  // Left curve
  ctx.beginPath();
  ctx.moveTo(cx - br * 0.55, cy - br * 0.6);
  ctx.bezierCurveTo(cx - br * 0.1, cy - br * 0.15, cx - br * 0.1, cy + br * 0.15, cx - br * 0.55, cy + br * 0.6);
  ctx.stroke();

  // Right curve
  ctx.beginPath();
  ctx.moveTo(cx + br * 0.55, cy - br * 0.6);
  ctx.bezierCurveTo(cx + br * 0.1, cy - br * 0.15, cx + br * 0.1, cy + br * 0.15, cx + br * 0.55, cy + br * 0.6);
  ctx.stroke();

  return c.toBuffer('image/png');
}

fs.writeFileSync('icon-192.png', makeIcon(192));
fs.writeFileSync('icon-512.png', makeIcon(512));
console.log('Icons generated.');
