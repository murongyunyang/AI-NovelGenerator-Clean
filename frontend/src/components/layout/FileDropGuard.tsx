"use client";

import { useEffect } from "react";
import { isFileDrag } from "@/lib/fileDrop";

/** 整页禁用文件拖入后的默认导航；保留事件，让导入面板继续读取文件。 */
export default function FileDropGuard() {
  useEffect(() => {
    const preventFileNavigation = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      if (event.type === "dragover" && event.dataTransfer) {
        event.dataTransfer.dropEffect = "none";
      }
    };
    window.addEventListener("dragover", preventFileNavigation, true);
    window.addEventListener("drop", preventFileNavigation, true);
    return () => {
      window.removeEventListener("dragover", preventFileNavigation, true);
      window.removeEventListener("drop", preventFileNavigation, true);
    };
  }, []);
  return null;
}
