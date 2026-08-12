/* @refresh reload */
import { render } from "solid-js/web"
import { App } from "./app"
import "./styles.css"

const root = document.getElementById("root")
if (!root) throw new Error("#root missing")
render(() => <App />, root)
