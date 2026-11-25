using System.Runtime.InteropServices;
using System.Windows.Forms.VisualStyles;

namespace D2Checkpoint.Launcher;

internal static class NativeTheme
{
    public const string WorkbenchTitle = "命运 2 检查点指挥台";
    public static Icon WorkbenchIcon { get; } = new(typeof(NativeTheme), "checkpoint.ico");
    public static Color Background => SystemInformation.HighContrast ? SystemColors.Window : Color.FromArgb(12, 16, 23);
    public static Color Surface => SystemInformation.HighContrast ? SystemColors.Control : Color.FromArgb(23, 29, 38);
    public static Color Text => SystemInformation.HighContrast ? SystemColors.WindowText : Color.FromArgb(239, 232, 216);
    public static Color Muted => SystemInformation.HighContrast ? SystemColors.WindowText : Color.FromArgb(172, 183, 197);
    public static Color Border => SystemInformation.HighContrast ? SystemColors.WindowFrame : Color.FromArgb(56, 66, 78);
    public static readonly Color Hover = Color.FromArgb(45, 54, 68);
    public static readonly Color Accent = Color.FromArgb(232, 185, 110);
    public static readonly Color AccentHover = Color.FromArgb(249, 206, 138);

    public static void StyleWindow(Form window)
    {
        window.Icon = WorkbenchIcon;
        window.BackColor = Background;
        window.ForeColor = Text;
        window.AutoScaleDimensions = new SizeF(96, 96);
        window.AutoScaleMode = AutoScaleMode.Dpi;

        if (!SystemInformation.HighContrast && OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000))
        {
            window.HandleCreated += (_, _) =>
            {
                const int useImmersiveDarkMode = 20;
                const int captionColor = 35;
                const int textColor = 36;
                var enabled = 1;
                _ = DwmSetWindowAttribute(window.Handle, useImmersiveDarkMode, ref enabled, sizeof(int));
                var caption = ColorTranslator.ToWin32(Surface);
                var text = ColorTranslator.ToWin32(Text);
                _ = DwmSetWindowAttribute(window.Handle, captionColor, ref caption, sizeof(int));
                _ = DwmSetWindowAttribute(window.Handle, textColor, ref text, sizeof(int));
            };
        }
    }

    public static void StyleTrayMenu(ContextMenuStrip menu)
    {
        menu.ShowImageMargin = false;
        if (SystemInformation.HighContrast) return;
        menu.ForeColor = Text;
        menu.Renderer = new ToolStripProfessionalRenderer(new TrayColors());
    }

    private sealed class TrayColors : ProfessionalColorTable
    {
        public override Color ToolStripDropDownBackground => Surface;
        public override Color MenuBorder => Border;
        public override Color MenuItemBorder => Border;
        public override Color MenuItemSelected => Hover;
        public override Color SeparatorDark => Border;
        public override Color SeparatorLight => Surface;
    }

    [DllImport("dwmapi.dll", ExactSpelling = true)]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int valueSize);
}

internal sealed class ToolbarButton : Button
{
    protected override void OnPaint(PaintEventArgs e)
    {
        if (Enabled || SystemInformation.HighContrast)
        {
            base.OnPaint(e);
            return;
        }

        // WinForms uses its system palette for disabled text, independently of ForeColor.
        e.Graphics.Clear(BackColor);
        ControlPaint.DrawBorder(e.Graphics, ClientRectangle, FlatAppearance.BorderColor, ButtonBorderStyle.Solid);
        TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, NativeTheme.Muted,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
    }
}

internal sealed class ToolbarCheckBox : CheckBox
{
    protected override void OnPaint(PaintEventArgs e)
    {
        if (Enabled || SystemInformation.HighContrast)
        {
            base.OnPaint(e);
            return;
        }

        var state = Checked ? CheckBoxState.CheckedDisabled : CheckBoxState.UncheckedDisabled;
        var glyph = CheckBoxRenderer.GetGlyphSize(e.Graphics, state);
        CheckBoxRenderer.DrawCheckBox(e.Graphics, new Point(0, (Height - glyph.Height) / 2), state);
        var text = Rectangle.FromLTRB(glyph.Width + LogicalToDeviceUnits(3), 0, Width, Height);
        TextRenderer.DrawText(e.Graphics, Text, Font, text, NativeTheme.Muted,
            TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);
    }
}
