import urls from "@/lib/urls";
import { Github } from "lucide-react";
import styles from "./styles.module.css";
import Logo from "../Logo";

interface FooterProps extends React.HTMLProps<HTMLElement> {}

const linkCategories: {
  category: string;
  links: { id: string; label: string; href: string; target?: string }[];
}[] = [
  {
    category: "产品",
    links: [
      { id: "Overview", label: "产品介绍", href: "/" },
      { id: "Features", label: "核心能力", href: "/#features" },
      { id: "Screenshots", label: "产品界面", href: "/#screenshots" },
      { id: "Download", label: "立即下载", href: "/#download" },
    ],
  },
  {
    category: "资源",
    links: [
      {
        id: "Docs",
        label: "使用文档",
        href: "https://github.com/gaopengbin/geo-downloader#readme",
        target: "_blank",
      },
      {
        id: "History",
        label: "历史版本",
        href: "/history",
      },
      {
        id: "Github",
        label: "GitHub",
        href: "https://github.com/gaopengbin/geo-downloader",
        target: "_blank",
      },
    ],
  },
  {
    category: "支持",
    links: [
      {
        id: "Discussion",
        label: "社区讨论",
        href: "https://github.com/gaopengbin/geo-downloader/discussions",
        target: "_blank",
      },
      {
        id: "Issues",
        label: "问题反馈",
        href: "https://github.com/gaopengbin/geo-downloader/issues",
        target: "_blank",
      },
      {
        id: "Disclaimer",
        label: "免责声明",
        href: urls.getDisclaimerUrl(),
      },
    ],
  },
];

const Footer: React.FC<FooterProps> = ({ className, ...rest }) => {
  return (
    <footer className={styles.footer} {...rest}>
      <div className="max-w-[1100px]">
        <section className={styles.footerSection}>
          <div className={styles.logoAndDescription}>
            <Logo height={35} loading="lazy" />
            <p className={styles.description}>
              GeoD 是面向 GIS 工作流的开源桌面数据工具，支持 2D 影像、DEM、3D
              Tiles 与历史影像下载。
            </p>
          </div>
          <div className={styles.categories}>
            {linkCategories.map((cat, i) => (
              <div key={i} className={styles.category}>
                <h3 className={styles.categoryName}>{cat.category}</h3>
                <div className={styles.links}>
                  {cat.links.map((link) => (
                    <a
                      key={link.id}
                      className={styles.link}
                      href={link.href}
                      target={link.target}
                      rel={link.target ? "noopener noreferrer" : undefined}
                    >
                      {link.label}
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className={styles.footerSectionSocial}>
          <p className={styles.footerSectionSocialCopy}>
            © {new Date().getFullYear()} GeoD / GeoDownloader
          </p>
          <a
            href={urls.getGithubUrl()}
            title="GitHub"
            aria-label="在 GitHub 查看 GeoD"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Github className={styles.footerSectionSocialImg} aria-hidden="true" />
          </a>
        </section>
      </div>
    </footer>
  );
};

export default Footer;
