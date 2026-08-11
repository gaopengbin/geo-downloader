import type { Metadata } from "next";
import Link from "next/link";

import Footer from "../_components/Footer";
import Background from "../_components/Background";
import Header from "../_components/Header";
import styles from "../geod-page.module.css";

export const metadata: Metadata = {
  title: "使用条款与免责声明",
  description: "GeoD 使用条款、数据授权边界与免责声明。",
  alternates: { canonical: "/disclaimer" },
};

const repositoryUrl = "https://github.com/gaopengbin/geo-downloader";

export default function DisclaimerPage() {
  return (
    <>
      <Background sticky />
      <Header />
      <main className={styles.page}>
        <article className={`${styles.legalSheet} ${styles.container}`}>
          <span className={styles.eyebrow}>Terms &amp; Disclaimer</span>
          <h1 className={styles.legalTitle}>使用条款与免责声明</h1>
          <p className={styles.updated}>最后更新：2026 年 8 月 11 日</p>

          <div className={styles.alert}>
            <strong>请务必先阅读本声明。</strong> 下载、安装或使用 GeoD（以下简称“本工具”）即视为您已阅读、理解并完全同意本声明的全部条款。如不同意，请立即停止使用并删除本工具。
          </div>

          <h2>一、工具性质</h2>
          <p>
            本工具是一款基于 Tauri + Rust 开发的开源桌面客户端，按 MIT 协议发布源码，<strong>不内置任何地图瓦片、影像、模型或矢量数据</strong>。所有数据来源于用户在使用过程中自行配置的第三方服务，包括但不限于 Esri、Google、Bing、天地图、高德、百度、腾讯、OpenStreetMap、Mapbox 或自建 WMTS。
          </p>
          <p>
            本工具仅作为协议适配与文件转换的技术工具，<strong>不解密、不破解、不绕过任何数据源的访问控制或加密措施</strong>。
          </p>

          <h2>二、用户责任</h2>
          <p>在使用本工具下载、处理或分发任何数据前，您必须自行承担以下责任：</p>
          <ol>
            <li>阅读并理解目标数据源的<strong>使用条款、API 配额与服务等级协议</strong>，并取得合法授权；</li>
            <li>遵守目标服务器的 <code>robots.txt</code>、Referer 限制、并发上限和速率配额；</li>
            <li>下载所得数据仅用于已获授权或属于合理使用范围的场景，例如个人学习、学术研究、内部测试；</li>
            <li>不得将数据用于商业出版、再分发、转售、训练商用模型等超出原服务条款允许范围的用途；</li>
            <li>遵守所在国家与地区有关测绘、地理信息、数据安全的法律法规；</li>
            <li>下载境内地图数据应取得合法测绘资质或获得数据所有方授权，境外数据应符合所在国法律及数据出境规定。</li>
          </ol>
          <p>
            特别说明：OpenStreetMap 官方公共标准瓦片服务主要用于正常的交互式地图浏览，
            <strong>不适合作为批量或离线下载源</strong>。建议优先使用自建瓦片服务，或选择明确允许离线使用的服务商。
            如仍使用第三方公共服务，请先阅读其
            {" "}
            <a
              href="https://operations.osmfoundation.org/policies/tiles/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Tile Usage Policy
            </a>
            ，确认授权、署名、缓存和访问频率要求后再继续。
          </p>

          <h2>三、版权归属</h2>
          <p>
            通过本工具下载的所有瓦片、栅格、矢量、3D 模型、元数据等内容，其著作权、邻接权及相关知识产权<strong>均归原数据提供方所有</strong>。本工具的开发者及贡献者对上述内容不主张任何权利、不提供任何授权、不承担任何许可担保。
          </p>

          <h2>四、禁止用途</h2>
          <p>您<strong>不得</strong>使用本工具实施下列任一行为：</p>
          <ul>
            <li>未经数据所有方明示授权，对其服务进行大规模、系统性、持续性的批量抓取；</li>
            <li>规避、破解、伪造、滥用访问控制、付费墙、API 凭证、签名校验或设备指纹；</li>
            <li>下载、传播、出售涉及国家秘密、军事禁区、敏感地理坐标的数据；</li>
            <li>用于侵犯他人隐私、名誉、财产或其他合法权益的活动；</li>
            <li>用于任何被国家法律、行政法规明令禁止的用途。</li>
          </ul>

          <h2>五、责任限制</h2>
          <p>
            本工具按“<strong>现状（AS IS）</strong>”提供，开发者及贡献者不就软件无错误、无中断、持续可用，或下载结果在精度、完整性、时效性方面满足任何特定用途作出担保。
          </p>
          <p>
            在适用法律允许的最大范围内，开发者及贡献者对您因使用或无法使用本工具而产生的直接、间接、附带、特别、惩罚性或后果性损害不承担责任。因使用本工具导致的法律纠纷、行政处罚、民事赔偿或刑事追责，均由使用者本人独立承担。
          </p>

          <h2>六、配合义务</h2>
          <p>
            如开发者收到数据所有方、监管机关或司法机关关于违规使用本工具的通知或调查请求，开发者有权在不另行通知用户的前提下配合调查并提供必要协助，包括发布安全更新、修改或下线相关功能、提供已公开的开源代码副本。
          </p>

          <h2>七、变更与终止</h2>
          <p>
            开发者保留随时修改、暂停、终止本工具任何功能或本声明任何条款的权利，无须事先通知。变更后的版本一经发布即生效，您继续使用本工具即视为接受变更。
          </p>

          <h2 id="anonymous-telemetry">八、匿名使用统计</h2>
          <p>
            GeoD 仅在用户明确选择“同意并开启”后发送匿名使用统计。统计数据包括随机生成的匿名安装标识、应用版本、操作系统类型、应用启动以及部分功能入口的使用情况，用于估算活跃安装量、版本分布并改进产品质量。
          </p>
          <p>
            匿名统计<strong>不包含</strong>下载地址、文件路径、文件名、搜索内容、地图坐标、选区范围、Token、API Key 或下载的数据。用户可以随时在设置中关闭统计或重置匿名标识；统计功能不属于 GeoD 核心功能。
          </p>

          <h2>九、争议解决</h2>
          <p>
            本声明的订立、履行与解释适用<strong>中华人民共和国法律</strong>。因本工具引发的争议，应首先通过友好协商解决；协商不成的，任一方均有权向开发者经常居住地有管辖权的人民法院提起诉讼。
          </p>

          <hr className={styles.legalDivider} />
          <p>
            本工具是个人开发者出于技术学习与开源分享目的制作。如您是数据所有方或权利人，认为本工具或其使用方式涉嫌侵犯您的合法权益，请通过 <a href={`${repositoryUrl}/issues`} target="_blank" rel="noopener noreferrer">GitHub Issues</a> 或微信 <code>gpb230314</code> 与开发者联系。
          </p>
          <Link className={styles.backLink} href="/">
            ← 返回首页
          </Link>
        </article>
      </main>
      <Footer />
    </>
  );
}
