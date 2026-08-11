"use client";
import cn from "classnames";

const WindowShell = ({ children }: React.HTMLProps<HTMLDivElement>) => {
  const clsBtns = "rounded-full size-[6px] md:size-[10px]";
  return (
    <div className="flex flex-col w-full outline outline-4 outline-[#ffffff33] bg-[#252527] rounded-t-[8px] md:rounded-t-[16px]">
      <div className="flex items-center px-2 md:px-4 gap-[5px] md:gap-[8px] h-[15px] md:h-[25px]">
        <div className={cn(clsBtns, "bg-[#ED6D60]")}></div>
        <div className={cn(clsBtns, "bg-[#F6BF52]")}></div>
        <div className={cn(clsBtns, "bg-[#64C556]")}></div>
      </div>
      {children}
    </div>
  );
};

export default WindowShell;
