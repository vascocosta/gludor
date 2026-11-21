export class KeyboardInput {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  /** Presses that arrived with Shift held, remembered until consumed. */
  private readonly shifted = new Set<string>();

  constructor() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.clear);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const code = event.code;
    if (
      code === "ArrowUp" ||
      code === "ArrowDown" ||
      code === "ArrowLeft" ||
      code === "ArrowRight" ||
      code === "Space" ||
      code === "F1" ||
      code === "F3" ||
      code === "F4"
    ) {
      event.preventDefault();
    }
    if (!event.repeat && !this.down.has(code)) {
      this.pressed.add(code);
      if (event.shiftKey) this.shifted.add(code);
    }
    this.down.add(code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.down.delete(event.code);
  };

  private readonly clear = (): void => {
    this.down.clear();
    this.pressed.clear();
    this.shifted.clear();
  };

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  consume(code: string): boolean {
    if (!this.pressed.has(code)) return false;
    this.pressed.delete(code);
    return true;
  }

  /**
   * Consume a press and report whether Shift was down when it happened. The
   * modifier is captured at keydown, so a quick tap still counts even if
   * Shift is released before the next frame.
   */
  consumeShifted(code: string): boolean {
    if (!this.pressed.has(code)) return false;
    this.pressed.delete(code);
    const shifted = this.shifted.has(code);
    this.shifted.delete(code);
    return shifted;
  }

  get pitch(): number {
    const pull = this.isDown("ArrowDown") || this.isDown("KeyS");
    const push = this.isDown("ArrowUp") || this.isDown("KeyW");
    return (pull ? 1 : 0) - (push ? 1 : 0);
  }

  get roll(): number {
    const right = this.isDown("ArrowRight") || this.isDown("KeyD");
    const left = this.isDown("ArrowLeft") || this.isDown("KeyA");
    return (right ? 1 : 0) - (left ? 1 : 0);
  }

  get rudder(): number {
    const right = this.isDown("KeyE");
    const left = this.isDown("KeyQ");
    return (right ? 1 : 0) - (left ? 1 : 0);
  }

  get brake(): number {
    return this.isDown("KeyB") ? 1 : 0;
  }

  get trimUp(): boolean {
    return this.isDown("KeyT");
  }

  get trimDown(): boolean {
    return this.isDown("KeyG");
  }

  get release(): boolean {
    return this.isDown("Space");
  }
}
