# overlay_ia.py
import sys, os, ctypes, threading, json, html
import requests
from PySide6.QtCore import (Qt, QPropertyAnimation, QEasingCurve, QRect, QRectF,
                            QObject, Signal, QEvent)
from PySide6.QtGui import QPainter, QColor, QPen, QLinearGradient, QPainterPath, QTextCursor
from PySide6.QtWidgets import (QApplication, QWidget, QVBoxLayout, QHBoxLayout, QLineEdit,
                               QPushButton, QTextBrowser, QComboBox)

API_KEY = os.environ.get("OPENAI_API_KEY", "")
API_URL = "https://api.openai.com/v1/chat/completions"
MODELS = ["gpt-4o-mini", "gpt-4o"]


# ---------- Effet verre (acrylique Windows 10/11) ----------
class ACCENTPOLICY(ctypes.Structure):
    _fields_ = [("AccentState", ctypes.c_int), ("AccentFlags", ctypes.c_int),
                ("GradientColor", ctypes.c_uint), ("AnimationId", ctypes.c_int)]


class WINCOMPATTRDATA(ctypes.Structure):
    _fields_ = [("Attribute", ctypes.c_int), ("Data", ctypes.c_void_p),
                ("SizeOfData", ctypes.c_size_t)]


def enable_acrylic(hwnd, tint=0x30FFFFFF):   # ABGR : teinte blanche semi-transparente
    accent = ACCENTPOLICY(4, 2, tint, 0)     # 4 = ACCENT_ENABLE_ACRYLICBLURBEHIND
    data = WINCOMPATTRDATA(19, ctypes.cast(ctypes.pointer(accent), ctypes.c_void_p),
                           ctypes.sizeof(accent))
    ctypes.windll.user32.SetWindowCompositionAttribute(hwnd, ctypes.byref(data))


class Bridge(QObject):
    token = Signal(str)
    done = Signal()
    toggle = Signal()


class Overlay(QWidget):
    COLLAPSED_W, COLLAPSED_H = 480, 66
    EXPANDED_W = 560

    def __init__(self):
        super().__init__()
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.history = []
        self.bridge = Bridge()
        self.bridge.token.connect(self.append_token)
        self.bridge.done.connect(self.on_done)
        self.bridge.toggle.connect(self.toggle_visible)

        root = QVBoxLayout(self)
        root.setContentsMargins(22, 12, 16, 12)
        root.setSpacing(8)

        self.chat = QTextBrowser()
        self.chat.setStyleSheet("background:transparent;border:none;color:#1d1d1f;font-size:14px;")
        self.chat.viewport().setAutoFillBackground(False)
        self.chat.hide()
        root.addWidget(self.chat, 1)

        row = QHBoxLayout()
        self.input = QLineEdit()
        self.input.setPlaceholderText("Demander n'importe quoi...")
        self.input.setStyleSheet("background:transparent;border:none;font-size:15px;color:#1d1d1f;")
        self.input.returnPressed.connect(self.send)
        self.input.installEventFilter(self)
        self.mic = self.round_btn("🎙")          # dictée vocale : à brancher
        row.addWidget(self.input, 1)
        row.addWidget(self.mic)
        root.addLayout(row)

        self.footer = QWidget()
        fl = QHBoxLayout(self.footer)
        fl.setContentsMargins(0, 0, 0, 0)
        self.model = QComboBox()
        self.model.addItems(MODELS)
        self.model.setStyleSheet("QComboBox{background:transparent;border:none;color:#555;font-size:12px;}")
        plus = QPushButton("+")
        plus.setFixedSize(30, 30)
        plus.setStyleSheet("QPushButton{background:transparent;border:none;color:#555;font-size:18px;}")
        self.send_btn = self.round_btn("➤")
        self.send_btn.clicked.connect(self.send)
        fl.addWidget(self.model)
        fl.addStretch()
        fl.addWidget(plus)
        fl.addWidget(self.send_btn)
        root.addWidget(self.footer)
        self.footer.hide()

        self.resize(self.COLLAPSED_W, self.COLLAPSED_H)

    # ----- helpers UI -----
    def round_btn(self, text):
        b = QPushButton(text)
        b.setFixedSize(36, 36)
        b.setCursor(Qt.PointingHandCursor)
        b.setStyleSheet("QPushButton{background:#111;color:white;border-radius:18px;font-size:15px;}"
                        "QPushButton:hover{background:#333;}")
        return b

    def paintEvent(self, _):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        path = QPainterPath()
        path.addRoundedRect(QRectF(self.rect()).adjusted(1, 1, -1, -1), 32, 32)
        g = QLinearGradient(0, 0, 0, self.height())
        g.setColorAt(0, QColor(255, 255, 255, 120))
        g.setColorAt(1, QColor(255, 255, 255, 40))
        p.fillPath(path, g)
        hl = QLinearGradient(0, 0, 0, self.height() * 0.5)   # reflet "liquid glass"
        hl.setColorAt(0, QColor(255, 255, 255, 90))
        hl.setColorAt(1, QColor(255, 255, 255, 0))
        p.fillPath(path, hl)
        p.setPen(QPen(QColor(255, 255, 255, 210), 1.2))
        p.drawPath(path)

    def showEvent(self, e):
        super().showEvent(e)
        enable_acrylic(int(self.winId()))

    # ----- animation barre -> carte -----
    def target_size(self, expanded):
        if not expanded:
            return self.COLLAPSED_W, self.COLLAPSED_H
        return self.EXPANDED_W, (460 if self.history else 200)

    def animate_to(self, expanded):
        self.footer.setVisible(expanded)
        self.chat.setVisible(expanded and bool(self.history))
        w, h = self.target_size(expanded)
        geo = self.geometry()
        target = QRect(geo.center().x() - w // 2, geo.y(), w, h)
        self.anim = QPropertyAnimation(self, b"geometry", self)
        self.anim.setDuration(280)
        self.anim.setEasingCurve(QEasingCurve.OutCubic)
        self.anim.setStartValue(geo)
        self.anim.setEndValue(target)
        self.anim.start()

    def eventFilter(self, obj, ev):
        if obj is self.input:
            if ev.type() == QEvent.FocusIn:
                self.animate_to(True)
            elif ev.type() == QEvent.KeyPress and ev.key() == Qt.Key_Escape:
                self.hide()
                return True
        return super().eventFilter(obj, ev)

    # ----- affichage / raccourci -----
    def place(self):
        s = QApplication.primaryScreen().availableGeometry()
        self.move(s.center().x() - self.width() // 2, s.top() + s.height() // 4)

    def toggle_visible(self):
        if self.isVisible():
            self.hide()
        else:
            self.show()
            self.activateWindow()
            self.input.setFocus()

    # ----- chat -----
    def append_token(self, text):
        cur = self.chat.textCursor()
        cur.movePosition(QTextCursor.End)
        cur.insertText(text)
        self.chat.setTextCursor(cur)
        self.chat.ensureCursorVisible()

    def send(self):
        text = self.input.text().strip()
        if not text:
            return
        self.input.clear()
        self.history.append({"role": "user", "content": text})
        self.chat.show()
        self.chat.append(f"<b>Vous :</b> {html.escape(text)}")
        self.chat.append("<b>IA :</b> ")
        self.animate_to(True)
        threading.Thread(target=self.stream,
                         args=(list(self.history), self.model.currentText()),
                         daemon=True).start()

    def stream(self, messages, model):
        full = ""
        try:
            r = requests.post(API_URL,
                              headers={"Authorization": f"Bearer {API_KEY}"},
                              json={"model": model, "messages": messages, "stream": True},
                              stream=True, timeout=60)
            r.raise_for_status()
            for line in r.iter_lines():
                if not line.startswith(b"data: "):
                    continue
                data = line[6:]
                if data == b"[DONE]":
                    break
                delta = json.loads(data)["choices"][0]["delta"].get("content", "")
                if delta:
                    full += delta
                    self.bridge.token.emit(delta)
        except Exception as e:
            self.bridge.token.emit(f"\n[Erreur : {e}]")
        self.history.append({"role": "assistant", "content": full})
        self.bridge.done.emit()

    def on_done(self):
        self.chat.append("")
        self.animate_to(True)   # ajuste la hauteur une fois la réponse affichée


if __name__ == "__main__":
    app = QApplication(sys.argv)
    w = Overlay()
    w.place()
    w.show()

    try:
        import keyboard                               # pip install keyboard
        keyboard.add_hotkey("ctrl+alt+space", w.bridge.toggle.emit)
    except ImportError:
        print("Module 'keyboard' absent : raccourci global désactivé.")

    sys.exit(app.exec())
