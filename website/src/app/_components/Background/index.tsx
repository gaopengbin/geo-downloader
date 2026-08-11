import cn from "classnames";
import styles from "./styles.module.css";
type Props = {
  sticky?: boolean;
};
const Background = ({ sticky }: Props) => (
  <div className={cn(styles.bg, sticky && styles.sticky)}></div>
);

export default Background;
