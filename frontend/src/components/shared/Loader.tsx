/* 各风格共用的等待动画：三个小部件，长什么样、怎么动由 styles/looks/motion.css 按 data-look 决定。
   动作是无限循环的，只要还在等待就一直在动，后端暂时没有消息时画面也不会停住。active 为假时停在静止的一帧。 */

export function Loader({ active = true, size = "md", className = "", label }: { active?: boolean; size?: "sm" | "md" | "lg"; className?: string; label?: string }) {
  return <span className={`ld ${className}`} data-active={active ? "true" : "false"} data-size={size}
    role={label ? "status" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    <i /><i /><i />
  </span>;
}
