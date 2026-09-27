"use client";
import cn from "classnames";

const WindowShell = ({ children }: React.HTMLProps<HTMLDivElement>) => {
  const clsBtns = "rounded-full size-[6px] md:size-[10px]";
  return (
    <div className="flex flex-col w-full overflow-hidden border border-[#dce3eb] bg-white rounded-[16px] shadow-[0_18px_50px_rgba(32,33,36,0.09)]">
      <div className="flex items-center px-3 md:px-4 gap-[5px] md:gap-[8px] h-[28px] md:h-[34px] border-b border-[#e8eaed] bg-[#f8fafd]">
        <div className={cn(clsBtns, "bg-[#ED6D60]")}></div>
        <div className={cn(clsBtns, "bg-[#F6BF52]")}></div>
        <div className={cn(clsBtns, "bg-[#64C556]")}></div>
      </div>
      {children}
    </div>
  );
};

export default WindowShell;
