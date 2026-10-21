/** An arrow pointing the way something travels, given the direction it comes from. */
export function Arrow({ from }: { from: number }) {
  return (
    <span className="arrow" role="img" style={{ transform: `rotate(${from + 180}deg)` }} aria-label={`from ${from}°`}>
      ↑
    </span>
  );
}

/** Props that make a non-button element (a table row, a line of text) work like a button from the keyboard. */
export function pressable(action: () => void) {
  return {
    role: "button",
    tabIndex: 0,
    onClick: action,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        action();
      }
    },
  } as const;
}
