// Semi-implicit integration with bounded substeps keeps release motion stable after slow frames.
export function stepSpring(
  position,
  velocity,
  target,
  elapsed,
  { stiffness = 340, damping = 22, mass = 0.85 } = {}
) {
  let time = Math.max(0, Math.min(0.05, elapsed));
  while (time > 0) {
    const dt = Math.min(time, 1 / 180);
    velocity += (((target - position) * stiffness - damping * velocity) / mass) * dt;
    position += velocity * dt;
    time -= dt;
  }
  return {
    position,
    velocity,
    settled: Math.abs(target - position) < 0.0008 && Math.abs(velocity) < 0.008,
  };
}
