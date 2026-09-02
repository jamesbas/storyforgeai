[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "generated")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:SlideWidth = 13.333
$script:SlideHeight = 7.5
$script:PowerPoint = $null
$script:Deck = $null

$script:Colors = @{
    Canvas = "0B0F17"
    CanvasSoft = "0F1520"
    Panel = "131A26"
    PanelLift = "182131"
    Border = "2A3548"
    Text = "F8FAFC"
    Muted = "A7B3C7"
    Indigo = "4F46E5"
    IndigoLight = "818CF8"
    Cyan = "38BDF8"
    CyanSoft = "12344A"
    Amber = "F59E0B"
    AmberSoft = "432A0B"
    Green = "10B981"
    GreenSoft = "0C342B"
    Rose = "FB7185"
    White = "FFFFFF"
}

function ConvertTo-Points {
    param([double]$Inches)
    return $Inches * 72
}

function ConvertTo-OfficeColor {
    param([string]$Hex)
    $clean = $Hex.TrimStart("#")
    $red = [Convert]::ToInt32($clean.Substring(0, 2), 16)
    $green = [Convert]::ToInt32($clean.Substring(2, 2), 16)
    $blue = [Convert]::ToInt32($clean.Substring(4, 2), 16)
    return $red + ($green * 256) + ($blue * 65536)
}

function Add-Rectangle {
    param(
        $Slide,
        [double]$X,
        [double]$Y,
        [double]$Width,
        [double]$Height,
        [string]$Fill,
        [string]$Line = $script:Colors.Border,
        [double]$LineWidth = 1,
        [double]$Transparency = 0,
        [switch]$Rounded
    )
    $shapeType = if ($Rounded) { 5 } else { 1 }
    $shape = $Slide.Shapes.AddShape(
        $shapeType,
        (ConvertTo-Points $X),
        (ConvertTo-Points $Y),
        (ConvertTo-Points $Width),
        (ConvertTo-Points $Height)
    )
    $shape.Fill.Visible = -1
    $shape.Fill.Solid()
    $shape.Fill.ForeColor.RGB = ConvertTo-OfficeColor $Fill
    $shape.Fill.Transparency = $Transparency
    if ($LineWidth -le 0) {
        $shape.Line.Visible = 0
    }
    else {
        $shape.Line.Visible = -1
        $shape.Line.ForeColor.RGB = ConvertTo-OfficeColor $Line
        $shape.Line.Weight = $LineWidth
    }
    return $shape
}

function Add-Circle {
    param(
        $Slide,
        [double]$X,
        [double]$Y,
        [double]$Diameter,
        [string]$Fill,
        [string]$Line = $Fill,
        [double]$LineWidth = 0
    )
    $shape = $Slide.Shapes.AddShape(
        9,
        (ConvertTo-Points $X),
        (ConvertTo-Points $Y),
        (ConvertTo-Points $Diameter),
        (ConvertTo-Points $Diameter)
    )
    $shape.Fill.Solid()
    $shape.Fill.ForeColor.RGB = ConvertTo-OfficeColor $Fill
    if ($LineWidth -le 0) {
        $shape.Line.Visible = 0
    }
    else {
        $shape.Line.ForeColor.RGB = ConvertTo-OfficeColor $Line
        $shape.Line.Weight = $LineWidth
    }
    return $shape
}

function Add-Text {
    param(
        $Slide,
        [string]$Text,
        [double]$X,
        [double]$Y,
        [double]$Width,
        [double]$Height,
        [double]$Size = 18,
        [string]$Color = $script:Colors.Text,
        [string]$Font = "Aptos",
        [switch]$Bold,
        [ValidateSet("left", "center", "right")]
        [string]$Align = "left",
        [ValidateSet("top", "middle", "bottom")]
        [string]$VerticalAlign = "top",
        [double]$Margin = 0,
        [switch]$NoFit
    )
    $shape = $Slide.Shapes.AddTextbox(
        1,
        (ConvertTo-Points $X),
        (ConvertTo-Points $Y),
        (ConvertTo-Points $Width),
        (ConvertTo-Points $Height)
    )
    $shape.Fill.Visible = 0
    $shape.Line.Visible = 0
    $shape.TextFrame2.MarginLeft = ConvertTo-Points $Margin
    $shape.TextFrame2.MarginRight = ConvertTo-Points $Margin
    $shape.TextFrame2.MarginTop = ConvertTo-Points $Margin
    $shape.TextFrame2.MarginBottom = ConvertTo-Points $Margin
    $shape.TextFrame2.WordWrap = -1
    if (-not $NoFit) {
        $shape.TextFrame2.AutoSize = 2
    }
    $shape.TextFrame2.VerticalAnchor = switch ($VerticalAlign) {
        "middle" { 3 }
        "bottom" { 4 }
        default { 1 }
    }
    $shape.TextFrame2.TextRange.Text = $Text
    $shape.TextFrame2.TextRange.Font.Name = $Font
    $shape.TextFrame2.TextRange.Font.Size = $Size
    $shape.TextFrame2.TextRange.Font.Fill.ForeColor.RGB = ConvertTo-OfficeColor $Color
    $shape.TextFrame2.TextRange.Font.Bold = if ($Bold) { -1 } else { 0 }
    $shape.TextFrame2.TextRange.ParagraphFormat.Alignment = switch ($Align) {
        "center" { 2 }
        "right" { 3 }
        default { 1 }
    }
    $shape.TextFrame2.TextRange.ParagraphFormat.SpaceAfter = 0
    return $shape
}

function Add-Line {
    param(
        $Slide,
        [double]$X1,
        [double]$Y1,
        [double]$X2,
        [double]$Y2,
        [string]$Color = $script:Colors.Border,
        [double]$Width = 1,
        [switch]$Arrow
    )
    $line = $Slide.Shapes.AddLine(
        (ConvertTo-Points $X1),
        (ConvertTo-Points $Y1),
        (ConvertTo-Points $X2),
        (ConvertTo-Points $Y2)
    )
    $line.Line.ForeColor.RGB = ConvertTo-OfficeColor $Color
    $line.Line.Weight = $Width
    if ($Arrow) {
        $line.Line.EndArrowheadStyle = 3
    }
    return $line
}

function Add-Pill {
    param(
        $Slide,
        [string]$Text,
        [double]$X,
        [double]$Y,
        [double]$Width,
        [double]$Height = 0.32,
        [string]$Fill = $script:Colors.PanelLift,
        [string]$Color = $script:Colors.Muted,
        [string]$Line = $script:Colors.Border,
        [double]$Size = 10
    )
    $null = Add-Rectangle $Slide $X $Y $Width $Height $Fill $Line 0.75 0 -Rounded
    $null = Add-Text $Slide $Text $X $Y $Width $Height $Size $Color "Aptos" -Bold -Align center -VerticalAlign middle
}

function Add-SectionBase {
    param($Slide, [string]$Section, [int]$Number)
    $null = Add-Rectangle $Slide 0 0 $script:SlideWidth $script:SlideHeight $script:Colors.Canvas $script:Colors.Canvas 0
    $null = Add-Rectangle $Slide 0 0 $script:SlideWidth 0.07 $script:Colors.Indigo $script:Colors.Indigo 0
    $null = Add-Text $Slide "STORYFORGEAI" 0.48 0.22 2.0 0.28 11 $script:Colors.Text "Aptos Display" -Bold
    $null = Add-Text $Slide $Section 10.1 0.22 2.72 0.28 9 $script:Colors.Muted "Aptos" -Bold -Align right
    $null = Add-Line $Slide 0.48 7.12 12.85 7.12 $script:Colors.Border 0.75
    $null = Add-Text $Slide "Local-first agentic creative studio" 0.48 7.2 4.1 0.18 8.5 $script:Colors.Muted
    $null = Add-Text $Slide ("{0:D2}" -f $Number) 12.25 7.18 0.6 0.2 9 $script:Colors.IndigoLight "Aptos" -Bold -Align right
}

function Add-SlideTitle {
    param(
        $Slide,
        [string]$Eyebrow,
        [string]$Title,
        [string]$Subtitle
    )
    $null = Add-Text $Slide $Eyebrow.ToUpperInvariant() 0.55 0.68 3.4 0.25 10 $script:Colors.Cyan "Aptos" -Bold
    $null = Add-Text $Slide $Title 0.55 0.98 12.1 0.62 27 $script:Colors.Text "Aptos Display" -Bold
    $null = Add-Text $Slide $Subtitle 0.55 1.58 11.9 0.43 12.5 $script:Colors.Muted
}

function Add-ImageContained {
    param(
        $Slide,
        [string]$Path,
        [double]$X,
        [double]$Y,
        [double]$Width,
        [double]$Height,
        [string]$Border = $script:Colors.Border
    )
    $null = Add-Rectangle $Slide $X $Y $Width $Height $script:Colors.Panel $Border 1 0 -Rounded
    Add-Type -AssemblyName System.Drawing
    $image = [System.Drawing.Image]::FromFile($Path)
    try {
        $imageRatio = $image.Width / $image.Height
        $boxRatio = $Width / $Height
        if ($imageRatio -gt $boxRatio) {
            $pictureWidth = $Width - 0.08
            $pictureHeight = $pictureWidth / $imageRatio
            $pictureX = $X + 0.04
            $pictureY = $Y + (($Height - $pictureHeight) / 2)
        }
        else {
            $pictureHeight = $Height - 0.08
            $pictureWidth = $pictureHeight * $imageRatio
            $pictureX = $X + (($Width - $pictureWidth) / 2)
            $pictureY = $Y + 0.04
        }
        $null = $Slide.Shapes.AddPicture(
            $Path,
            0,
            -1,
            (ConvertTo-Points $pictureX),
            (ConvertTo-Points $pictureY),
            (ConvertTo-Points $pictureWidth),
            (ConvertTo-Points $pictureHeight)
        )
    }
    finally {
        $image.Dispose()
    }
}

function Add-StepCard {
    param(
        $Slide,
        [string]$Number,
        [string]$Title,
        [string]$Body,
        [double]$X,
        [double]$Y,
        [double]$Width,
        [string]$Accent
    )
    $null = Add-Rectangle $Slide $X $Y $Width 1.28 $script:Colors.Panel $script:Colors.Border 1 0 -Rounded
    $null = Add-Circle $Slide ($X + 0.16) ($Y + 0.16) 0.38 $Accent
    $null = Add-Text $Slide $Number ($X + 0.16) ($Y + 0.16) 0.38 0.38 11 $script:Colors.Canvas "Aptos" -Bold -Align center -VerticalAlign middle
    $null = Add-Text $Slide $Title ($X + 0.62) ($Y + 0.14) ($Width - 0.78) 0.34 14 $script:Colors.Text "Aptos Display" -Bold
    $null = Add-Text $Slide $Body ($X + 0.16) ($Y + 0.62) ($Width - 0.32) 0.5 10.5 $script:Colors.Muted
}

function Add-AgentCard {
    param(
        $Slide,
        [string]$Initials,
        [string]$Name,
        [string]$Artifact,
        [double]$X,
        [double]$Y,
        [double]$Width,
        [string]$Accent
    )
    $null = Add-Rectangle $Slide $X $Y $Width 0.83 $script:Colors.Panel $script:Colors.Border 0.85 0 -Rounded
    $null = Add-Circle $Slide ($X + 0.13) ($Y + 0.14) 0.52 $Accent
    $null = Add-Text $Slide $Initials ($X + 0.13) ($Y + 0.14) 0.52 0.52 10 $script:Colors.Canvas "Aptos" -Bold -Align center -VerticalAlign middle
    $null = Add-Text $Slide $Name ($X + 0.78) ($Y + 0.12) ($Width - 0.9) 0.27 12 $script:Colors.Text "Aptos Display" -Bold
    $null = Add-Text $Slide $Artifact ($X + 0.78) ($Y + 0.43) ($Width - 0.9) 0.22 9.5 $script:Colors.Muted
}

function Add-OutcomeCard {
    param(
        $Slide,
        [string]$Title,
        [string]$Body,
        [double]$X,
        [double]$Y,
        [double]$Width,
        [string]$Accent
    )
    $null = Add-Rectangle $Slide $X $Y $Width 0.95 $script:Colors.Panel $script:Colors.Border 0.8 0 -Rounded
    $null = Add-Rectangle $Slide $X $Y 0.07 0.95 $Accent $Accent 0
    $null = Add-Text $Slide $Title ($X + 0.2) ($Y + 0.12) ($Width - 0.34) 0.25 12 $script:Colors.Text "Aptos Display" -Bold
    $null = Add-Text $Slide $Body ($X + 0.2) ($Y + 0.43) ($Width - 0.34) 0.37 9.8 $script:Colors.Muted
}

function New-BlankSlide {
    $slide = $script:Deck.Slides.Add($script:Deck.Slides.Count + 1, 12)
    return $slide
}

function Add-TitleSlide {
    param([string]$StoryboardImage)
    $slide = New-BlankSlide
    $null = Add-Rectangle $slide 0 0 $script:SlideWidth $script:SlideHeight $script:Colors.Canvas $script:Colors.Canvas 0
    $null = Add-Rectangle $slide 0 0 0.09 $script:SlideHeight $script:Colors.Indigo $script:Colors.Indigo 0
    $null = Add-Text $slide "STORYFORGEAI" 0.62 0.56 2.4 0.36 13 $script:Colors.Cyan "Aptos Display" -Bold
    $null = Add-Text $slide "From one idea to an approved AI media package" 0.62 1.42 5.9 1.38 32 $script:Colors.Text "Aptos Display" -Bold
    $null = Add-Text $slide "A local-first production workspace where specialized agents plan the story, write scene-level keyframe and video prompts, and orchestrate Wan2GP through MCP." 0.62 3.03 5.62 1.08 15 $script:Colors.Muted
    Add-Pill $slide "AGENTIC PLANNING" 0.62 4.47 1.75 0.34 $script:Colors.CyanSoft $script:Colors.Cyan $script:Colors.Cyan
    Add-Pill $slide "SCENE CONTRACTS" 2.49 4.47 1.72 0.34 $script:Colors.PanelLift $script:Colors.IndigoLight $script:Colors.IndigoLight
    Add-Pill $slide "WAN2GP MCP" 4.33 4.47 1.35 0.34 $script:Colors.AmberSoft $script:Colors.Amber $script:Colors.Amber
    $null = Add-Line $slide 0.62 5.2 5.95 5.2 $script:Colors.Border 1
    $null = Add-Text $slide "Business and solution engineering overview" 0.62 5.43 4.8 0.33 12 $script:Colors.Text "Aptos" -Bold
    $null = Add-Text $slide "Editable PowerPoint + audience-specific infographics" 0.62 5.79 4.9 0.28 10.5 $script:Colors.Muted
    $null = Add-Rectangle $slide 6.74 0.62 5.95 5.98 $script:Colors.Panel $script:Colors.Border 1 0 -Rounded
    Add-ImageContained $slide $StoryboardImage 6.91 0.82 5.61 4.75
    $null = Add-Text $slide "SCENE-LEVEL OUTPUT" 7.15 5.79 2.2 0.22 9.5 $script:Colors.Cyan "Aptos" -Bold
    $null = Add-Text $slide "Objective + camera + prompts + start/end keyframes + clip + approval" 7.15 6.08 5.0 0.35 11 $script:Colors.Text "Aptos" -Bold
    $null = Add-Text $slide "StoryForgeAI integrates with WanGP/Wan2GP as an independent media backend. Model licenses and commercial-use terms vary." 0.62 6.93 12.0 0.24 8.5 $script:Colors.Muted
}

function Add-ProductFlowSlide {
    $slide = New-BlankSlide
    Add-SectionBase $slide "PRODUCT STORY" 2
    Add-SlideTitle $slide "Operating model" "A production system, not a one-shot prompt" "Creative intent becomes a chain of explicit, editable artifacts before GPU generation begins."

    $steps = @(
        @{ N = "1"; T = "Intent"; B = "Concept, duration, style, tone, audience"; A = $script:Colors.Cyan },
        @{ N = "2"; T = "Creative plans"; B = "World, direction, camera, art and variants"; A = $script:Colors.Cyan },
        @{ N = "3"; T = "Storyboard"; B = "Timed scene cards with continuity decisions"; A = $script:Colors.IndigoLight },
        @{ N = "4"; T = "Media prompts"; B = "Start/end keyframes plus motion-first video text"; A = $script:Colors.IndigoLight },
        @{ N = "5"; T = "Approved cut"; B = "Wan2GP attempts, QC, approval and assembly"; A = $script:Colors.Amber }
    )
    for ($index = 0; $index -lt $steps.Count; $index++) {
        $x = 0.55 + ($index * 2.52)
        Add-StepCard $slide $steps[$index].N $steps[$index].T $steps[$index].B $x 2.28 2.18 $steps[$index].A
        if ($index -lt ($steps.Count - 1)) {
            $null = Add-Line $slide ($x + 2.19) 2.93 ($x + 2.47) 2.93 $script:Colors.Border 1.5 -Arrow
        }
    }

    $null = Add-Text $slide "WHAT CHANGES" 0.55 4.08 2.0 0.24 10 $script:Colors.Cyan "Aptos" -Bold
    Add-OutcomeCard $slide "Before rendering" "Leaders and creators can review the creative logic while revisions are still inexpensive." 0.55 4.43 3.82 $script:Colors.Cyan
    Add-OutcomeCard $slide "During rendering" "Each attempt stays attached to its scene, prompts, seed, model choice and approval state." 4.76 4.43 3.82 $script:Colors.IndigoLight
    Add-OutcomeCard $slide "After rendering" "Only approved clips reach assembly; exports preserve the storyboard and generation manifest." 8.97 4.43 3.82 $script:Colors.Amber

    $null = Add-Rectangle $slide 0.55 5.66 12.24 0.88 $script:Colors.CanvasSoft $script:Colors.Border 0.8 0 -Rounded
    $null = Add-Text $slide "Core idea" 0.78 5.91 1.05 0.24 10 $script:Colors.IndigoLight "Aptos" -Bold
    $null = Add-Text $slide "Make the production decisions visible, editable and reusable before asking image and video models to execute them." 1.75 5.82 10.65 0.37 15 $script:Colors.Text "Aptos Display" -Bold
}

function Add-BusinessInfographicSlide {
    $slide = New-BlankSlide
    Add-SectionBase $slide "BUSINESS INFOGRAPHIC" 3
    Add-SlideTitle $slide "For business leaders" "Creative scale with control points built in" "StoryForgeAI coordinates specialized AI work around a shared storyboard, keeping human choice visible from direction to final cut."

    $pipelineY = 2.36
    $pipeline = @(
        @{ T = "BUSINESS INTENT"; S = "Concept + audience"; A = $script:Colors.Cyan },
        @{ T = "AI CREATIVE CREW"; S = "Plans + variants"; A = $script:Colors.Cyan },
        @{ T = "STORYBOARD"; S = "Timed scene decisions"; A = $script:Colors.IndigoLight },
        @{ T = "WAN2GP"; S = "Keyframes + clips"; A = $script:Colors.Amber },
        @{ T = "APPROVED PACKAGE"; S = "Cut + manifests"; A = $script:Colors.Green }
    )
    for ($index = 0; $index -lt $pipeline.Count; $index++) {
        $x = 0.55 + ($index * 2.5)
        $null = Add-Rectangle $slide $x $pipelineY 2.12 1.1 $script:Colors.Panel $pipeline[$index].A 1.3 0 -Rounded
        $null = Add-Rectangle $slide $x $pipelineY 2.12 0.08 $pipeline[$index].A $pipeline[$index].A 0
        $null = Add-Text $slide $pipeline[$index].T ($x + 0.13) ($pipelineY + 0.21) 1.86 0.27 10.5 $script:Colors.Text "Aptos Display" -Bold -Align center
        $null = Add-Text $slide $pipeline[$index].S ($x + 0.13) ($pipelineY + 0.6) 1.86 0.24 9.5 $script:Colors.Muted "Aptos" -Align center
        if ($index -lt ($pipeline.Count - 1)) {
            $null = Add-Line $slide ($x + 2.13) 2.91 ($x + 2.43) 2.91 $script:Colors.Border 1.4 -Arrow
        }
    }

    $null = Add-Text $slide "BUSINESS VALUE" 0.55 3.87 2.0 0.24 10 $script:Colors.Cyan "Aptos" -Bold
    Add-OutcomeCard $slide "Align earlier" "Select a creative direction and inspect the plan before committing render time." 0.55 4.2 2.83 $script:Colors.Cyan
    Add-OutcomeCard $slide "Reduce rework" "Edit one scene or rewrite one prompt pass without rebuilding the whole project." 3.58 4.2 2.83 $script:Colors.IndigoLight
    Add-OutcomeCard $slide "Protect consistency" "World, camera, cast, wardrobe and continuity decisions follow the scene." 6.61 4.2 2.83 $script:Colors.Amber
    Add-OutcomeCard $slide "Keep accountability" "Attempts, QC findings and approvals remain attached to the production record." 9.64 4.2 2.83 $script:Colors.Green

    $null = Add-Rectangle $slide 0.55 5.49 12.0 0.88 $script:Colors.PanelLift $script:Colors.Border 0.8 0 -Rounded
    $null = Add-Text $slide "HUMAN CHECKPOINTS" 0.78 5.76 1.55 0.22 9.5 $script:Colors.IndigoLight "Aptos" -Bold
    Add-Pill $slide "Select direction" 2.62 5.69 1.55 0.34 $script:Colors.CanvasSoft $script:Colors.Text $script:Colors.Border
    $null = Add-Line $slide 4.28 5.86 4.63 5.86 $script:Colors.Border 1.2 -Arrow
    Add-Pill $slide "Edit scene" 4.73 5.69 1.36 0.34 $script:Colors.CanvasSoft $script:Colors.Text $script:Colors.Border
    $null = Add-Line $slide 6.2 5.86 6.55 5.86 $script:Colors.Border 1.2 -Arrow
    Add-Pill $slide "Review attempts" 6.65 5.69 1.57 0.34 $script:Colors.CanvasSoft $script:Colors.Text $script:Colors.Border
    $null = Add-Line $slide 8.33 5.86 8.68 5.86 $script:Colors.Border 1.2 -Arrow
    Add-Pill $slide "Approve clip" 8.78 5.69 1.48 0.34 $script:Colors.CanvasSoft $script:Colors.Text $script:Colors.Border
    $null = Add-Line $slide 10.37 5.86 10.72 5.86 $script:Colors.Border 1.2 -Arrow
    Add-Pill $slide "Assemble" 10.82 5.69 1.1 0.34 $script:Colors.GreenSoft $script:Colors.Green $script:Colors.Green
    $null = Add-Text $slide "LOCAL-FIRST OPTION  |  DEMO WITHOUT EXTERNAL SERVICES  |  MODEL BACKENDS REMAIN SWAPPABLE" 1.28 6.61 10.8 0.22 9.5 $script:Colors.Muted "Aptos" -Bold -Align center
}

function Add-AgentCrewSlide {
    param([string]$CanvasImage)
    $slide = New-BlankSlide
    Add-SectionBase $slide "AGENTIC CANVAS" 4
    Add-SlideTitle $slide "Creative intelligence" "A visible crew, each accountable for one artifact" "Agents do not blend into one opaque answer. Their plans are stored, reviewed and applied when the storyboard is generated."

    $null = Add-Text $slide "PLANNING CREW" 0.55 2.17 2.0 0.22 9.5 $script:Colors.Cyan "Aptos" -Bold
    Add-AgentCard $slide "VE" "Variant Explorer" "Three creative directions" 0.55 2.48 3.03 $script:Colors.Cyan
    Add-AgentCard $slide "WB" "World Builder" "Rules, locations, motifs, contradictions" 0.55 3.41 3.03 $script:Colors.Cyan
    Add-AgentCard $slide "DR" "Director" "Thesis, pacing, performance, scene intent" 0.55 4.34 3.03 $script:Colors.IndigoLight
    Add-AgentCard $slide "CI" "Cinematographer" "Shot language, lens, movement, lighting" 0.55 5.27 3.03 $script:Colors.IndigoLight
    Add-AgentCard $slide "AD" "Art Director" "Production design, props, color, wardrobe" 0.55 6.2 3.03 $script:Colors.Amber

    $null = Add-Text $slide "PRODUCTION HANDOFF" 3.93 2.17 2.3 0.22 9.5 $script:Colors.IndigoLight "Aptos" -Bold
    $null = Add-Rectangle $slide 3.93 2.48 3.18 4.55 $script:Colors.Panel $script:Colors.Border 0.9 0 -Rounded
    $handoffs = @(
        @{ N = "1"; T = "Intake Producer"; B = "normalizes the brief" },
        @{ N = "2"; T = "Story Architect"; B = "creates one beat per segment" },
        @{ N = "3"; T = "Visual Bible"; B = "consolidates continuity rules" },
        @{ N = "4"; T = "Storyboard Artist"; B = "writes timed scene cards" },
        @{ N = "5"; T = "Prompt Engineers"; B = "write image + video prompts per scene" }
    )
    for ($index = 0; $index -lt $handoffs.Count; $index++) {
        $y = 2.75 + ($index * 0.79)
        $null = Add-Circle $slide 4.18 $y 0.37 $script:Colors.PanelLift $script:Colors.IndigoLight 1
        $null = Add-Text $slide $handoffs[$index].N 4.18 $y 0.37 0.37 9.5 $script:Colors.IndigoLight "Aptos" -Bold -Align center -VerticalAlign middle
        $null = Add-Text $slide $handoffs[$index].T 4.71 ($y - 0.01) 2.08 0.24 11 $script:Colors.Text "Aptos Display" -Bold
        $null = Add-Text $slide $handoffs[$index].B 4.71 ($y + 0.27) 2.08 0.22 9 $script:Colors.Muted
        if ($index -lt ($handoffs.Count - 1)) {
            $null = Add-Line $slide 4.365 ($y + 0.39) 4.365 ($y + 0.73) $script:Colors.Border 1.1
        }
    }
    $null = Add-Text $slide "Plan influence is bound when the storyboard runs; later plan changes require storyboard regeneration." 4.17 6.67 2.68 0.25 8.5 $script:Colors.Amber

    $null = Add-Text $slide "THE APP MAKES THE CREW LEGIBLE" 7.45 2.17 3.0 0.22 9.5 $script:Colors.Cyan "Aptos" -Bold
    Add-ImageContained $slide $CanvasImage 7.45 2.48 5.35 4.55
}

function Add-SceneContractSlide {
    param([string]$StoryboardImage)
    $slide = New-BlankSlide
    Add-SectionBase $slide "STORYBOARD + PROMPTS" 5
    Add-SlideTitle $slide "Generation contract" "Every scene becomes a controllable media instruction" "The storyboard connects creative intent to two keyframes, a motion-focused video prompt, model settings and an approval decision."

    $null = Add-Rectangle $slide 0.55 2.23 3.16 4.48 $script:Colors.Panel $script:Colors.Border 0.9 0 -Rounded
    $null = Add-Text $slide "SCENE CARD" 0.8 2.49 1.4 0.23 9.5 $script:Colors.Cyan "Aptos" -Bold
    $null = Add-Text $slide "The creative source of truth" 0.8 2.81 2.5 0.32 16 $script:Colors.Text "Aptos Display" -Bold
    $cardItems = @("Objective + story beat", "Visual + action description", "Camera movement + timing", "Cast present + wardrobe state", "Continuity into the next scene")
    for ($index = 0; $index -lt $cardItems.Count; $index++) {
        $y = 3.43 + ($index * 0.52)
        $null = Add-Circle $slide 0.83 ($y + 0.04) 0.17 $script:Colors.Cyan
        $null = Add-Text $slide $cardItems[$index] 1.12 $y 2.22 0.25 10.5 $script:Colors.Muted
    }
    Add-Pill $slide "Editable before render" 0.8 6.16 1.86 0.34 $script:Colors.CyanSoft $script:Colors.Cyan $script:Colors.Cyan

    $null = Add-Line $slide 3.78 4.3 4.12 4.3 $script:Colors.Border 1.5 -Arrow
    $null = Add-Rectangle $slide 4.17 2.23 4.13 4.48 $script:Colors.Panel $script:Colors.IndigoLight 1 0 -Rounded
    $null = Add-Text $slide "KEYFRAME PROMPTS" 4.43 2.49 1.8 0.23 9.5 $script:Colors.IndigoLight "Aptos" -Bold
    $null = Add-Text $slide "Start state" 4.43 2.86 1.3 0.27 13 $script:Colors.Text "Aptos Display" -Bold
    $null = Add-Text $slide "Establish framing, subject, set, wardrobe and lighting." 4.43 3.18 3.3 0.42 10.5 $script:Colors.Muted
    $null = Add-Line $slide 4.48 3.87 7.92 3.87 $script:Colors.Border 1.2 -Arrow
    Add-Pill $slide "PREVIOUS END FRAME CAN CARRY FORWARD" 4.63 3.69 2.98 0.34 $script:Colors.CanvasSoft $script:Colors.IndigoLight $script:Colors.Border 8.5
    $null = Add-Text $slide "End state" 4.43 4.3 1.3 0.27 13 $script:Colors.Text "Aptos Display" -Bold
    $null = Add-Text $slide "Describe where the scene must land; optionally condition on the opening frame." 4.43 4.62 3.3 0.48 10.5 $script:Colors.Muted
    $null = Add-Rectangle $slide 4.43 5.42 3.56 0.83 $script:Colors.CanvasSoft $script:Colors.Border 0.7 0 -Rounded
    $null = Add-Text $slide "Model-aware rules" 4.64 5.59 1.38 0.22 10 $script:Colors.Cyan "Aptos" -Bold
    $null = Add-Text $slide "Cast scope + wardrobe + LoRAs + family directive + exclusions" 4.64 5.87 3.04 0.23 9.2 $script:Colors.Muted

    $null = Add-Line $slide 8.37 4.3 8.71 4.3 $script:Colors.Border 1.5 -Arrow
    $null = Add-Rectangle $slide 8.76 2.23 4.04 4.48 $script:Colors.Panel $script:Colors.Amber 1 0 -Rounded
    $null = Add-Text $slide "VIDEO PROMPT" 9.02 2.49 1.7 0.23 9.5 $script:Colors.Amber "Aptos" -Bold
    $null = Add-Text $slide "Motion between the frames" 9.02 2.81 3.3 0.34 16 $script:Colors.Text "Aptos Display" -Bold
    $null = Add-Text $slide "Action progression" 9.02 3.43 1.62 0.24 11 $script:Colors.Text "Aptos" -Bold
    $null = Add-Text $slide "Camera motion + pacing" 9.02 3.86 1.94 0.24 11 $script:Colors.Text "Aptos" -Bold
    $null = Add-Text $slide "Identity + continuity constraints" 9.02 4.29 2.45 0.24 11 $script:Colors.Text "Aptos" -Bold
    $null = Add-Text $slide "Duration + native audio direction" 9.02 4.72 2.45 0.24 11 $script:Colors.Text "Aptos" -Bold
    $null = Add-Rectangle $slide 9.02 5.28 3.52 0.98 $script:Colors.AmberSoft $script:Colors.Amber 0.8 0 -Rounded
    $null = Add-Text $slide "WAN2GP-READY" 9.25 5.47 1.4 0.23 10 $script:Colors.Amber "Aptos" -Bold
    $null = Add-Text $slide "Prompt + schema-valid settings + media references" 9.25 5.79 2.99 0.25 10 $script:Colors.Text

    $null = Add-Text $slide "The scene card remains editable; image and video prompt passes can be rewritten independently." 4.2 6.78 4.6 0.2 8.8 $script:Colors.Muted -Align center
}

function Add-TechnicalInfographicSlide {
    $slide = New-BlankSlide
    Add-SectionBase $slide "TECHNICAL INFOGRAPHIC" 6
    Add-SlideTitle $slide "For solution engineers" "Artifact-driven orchestration across local AI services" "A TypeScript control plane stores creative state, resolves per-scene context, and sends schema-valid generation jobs to Wan2GP over MCP."

    $layerY = 2.2
    $layers = @(
        @{ T = "EXPERIENCE"; B = "Next.js UI`nProjects | Canvas | Storyboard | Console | Assembly"; X = 0.55; W = 2.35; A = $script:Colors.Cyan },
        @{ T = "CONTROL PLANE"; B = "API routes + services`nOrchestrators | queues | approvals | exports"; X = 3.2; W = 2.35; A = $script:Colors.Cyan },
        @{ T = "CREATIVE ARTIFACTS"; B = "Zod-validated records`nBrief | plans | scenes | prompts | attempts"; X = 5.85; W = 2.35; A = $script:Colors.IndigoLight },
        @{ T = "MCP ADAPTER"; B = "Wan2GP client`nDiscover | schema | submit | poll | cancel"; X = 8.5; W = 2.35; A = $script:Colors.Amber },
        @{ T = "MEDIA ENGINE"; B = "Installed model families`nImage | video | audio | postprocess"; X = 11.15; W = 1.63; A = $script:Colors.Amber }
    )
    foreach ($layer in $layers) {
        $null = Add-Rectangle $slide $layer.X $layerY $layer.W 1.38 $script:Colors.Panel $layer.A 1.2 0 -Rounded
        $null = Add-Text $slide $layer.T ($layer.X + 0.13) ($layerY + 0.16) ($layer.W - 0.26) 0.23 9.5 $layer.A "Aptos" -Bold -Align center
        $null = Add-Text $slide $layer.B ($layer.X + 0.13) ($layerY + 0.53) ($layer.W - 0.26) 0.62 9.6 $script:Colors.Text "Aptos" -Align center -VerticalAlign middle
    }
    for ($index = 0; $index -lt 4; $index++) {
        $from = $layers[$index]
        $to = $layers[$index + 1]
        $null = Add-Line $slide ($from.X + $from.W + 0.04) 2.89 ($to.X - 0.08) 2.89 $script:Colors.Border 1.5 -Arrow
    }

    $null = Add-Text $slide "PER-SCENE RESOLUTION BEFORE THE PROMPT CALL" 0.55 3.95 4.4 0.23 9.5 $script:Colors.IndigoLight "Aptos" -Bold
    $resolver = @(
        @{ T = "Cast scope"; B = "Who is in this shot?" },
        @{ T = "Wardrobe timeline"; B = "What are they wearing now?" },
        @{ T = "Model family"; B = "Which prompt grammar applies?" },
        @{ T = "Continuity"; B = "Cut, carried frame or clip continuation?" }
    )
    for ($index = 0; $index -lt $resolver.Count; $index++) {
        $x = 0.55 + ($index * 2.38)
        $null = Add-Rectangle $slide $x 4.28 2.15 0.98 $script:Colors.CanvasSoft $script:Colors.Border 0.8 0 -Rounded
        $null = Add-Text $slide $resolver[$index].T ($x + 0.15) 4.44 1.85 0.23 10.5 $script:Colors.Text "Aptos Display" -Bold -Align center
        $null = Add-Text $slide $resolver[$index].B ($x + 0.15) 4.75 1.85 0.28 8.8 $script:Colors.Muted "Aptos" -Align center
    }
    $null = Add-Line $slide 10.03 4.77 10.48 4.77 $script:Colors.IndigoLight 1.5 -Arrow
    $null = Add-Rectangle $slide 10.55 4.22 2.23 1.1 $script:Colors.PanelLift $script:Colors.IndigoLight 1.1 0 -Rounded
    $null = Add-Text $slide "2 calls / scene" 10.72 4.43 1.89 0.27 14 $script:Colors.Text "Aptos Display" -Bold -Align center
    $null = Add-Text $slide "image pass + video pass" 10.72 4.81 1.89 0.22 9.2 $script:Colors.IndigoLight "Aptos" -Bold -Align center

    $null = Add-Text $slide "OPTIONAL LOCAL SIDECARS" 0.55 5.66 2.6 0.23 9.5 $script:Colors.Cyan "Aptos" -Bold
    Add-Pill $slide "OpenAI-compatible planning LLM" 0.55 6.0 2.72 0.36 $script:Colors.CyanSoft $script:Colors.Cyan $script:Colors.Cyan 9
    Add-Pill $slide "JSON file project store" 3.48 6.0 2.12 0.36 $script:Colors.PanelLift $script:Colors.Text $script:Colors.Border 9
    Add-Pill $slide "ffmpeg assembly" 5.81 6.0 1.62 0.36 $script:Colors.PanelLift $script:Colors.Text $script:Colors.Border 9
    Add-Pill $slide "Deepy assist" 7.64 6.0 1.35 0.36 $script:Colors.PanelLift $script:Colors.Text $script:Colors.Border 9
    Add-Pill $slide "Deterministic mocks for demo/test" 9.2 6.0 2.82 0.36 $script:Colors.GreenSoft $script:Colors.Green $script:Colors.Green 9
    $null = Add-Text $slide "External systems are feature-gated behind swappable interfaces; live media generation requires a reachable Wan2GP MCP server." 1.15 6.55 11.0 0.24 9.3 $script:Colors.Muted "Aptos" -Align center
}

function Add-McpSlide {
    param([string]$ConsoleImage)
    $slide = New-BlankSlide
    Add-SectionBase $slide "WAN2GP MCP" 7
    Add-SlideTitle $slide "Execution path" "Prompts become model-valid jobs, not raw guesses" "StoryForge queries the backend that is actually installed, composes settings from its schema, and tracks every job through completion."

    $stages = @(
        @{ N = "01"; T = "Discover"; B = "List installed image, video and audio models"; A = $script:Colors.Cyan },
        @{ N = "02"; T = "Resolve"; B = "Honor pins or route by capability and family"; A = $script:Colors.Cyan },
        @{ N = "03"; T = "Compose"; B = "Merge schema defaults, prompts, LoRAs and refs"; A = $script:Colors.IndigoLight },
        @{ N = "04"; T = "Execute"; B = "Submit, poll and cancel through MCP"; A = $script:Colors.Amber },
        @{ N = "05"; T = "Record"; B = "Store outputs as a scene attempt for review"; A = $script:Colors.Green }
    )
    for ($index = 0; $index -lt $stages.Count; $index++) {
        $x = 0.55 + ($index * 2.49)
        $null = Add-Circle $slide $x 2.35 0.54 $stages[$index].A
        $null = Add-Text $slide $stages[$index].N $x 2.35 0.54 0.54 10 $script:Colors.Canvas "Aptos" -Bold -Align center -VerticalAlign middle
        $null = Add-Text $slide $stages[$index].T ($x + 0.68) 2.34 1.43 0.27 13 $script:Colors.Text "Aptos Display" -Bold
        $null = Add-Text $slide $stages[$index].B ($x + 0.68) 2.7 1.5 0.55 9.2 $script:Colors.Muted
        if ($index -lt ($stages.Count - 1)) {
            $null = Add-Line $slide ($x + 2.14) 2.62 ($x + 2.4) 2.62 $script:Colors.Border 1.3 -Arrow
        }
    }

    Add-ImageContained $slide $ConsoleImage 0.55 3.58 5.7 2.92
    $null = Add-Rectangle $slide 6.59 3.58 6.2 2.92 $script:Colors.Panel $script:Colors.Border 0.9 0 -Rounded
    $null = Add-Text $slide "MODEL-ORDERED MEDIA PIPELINE" 6.86 3.84 3.0 0.23 9.5 $script:Colors.Amber "Aptos" -Bold
    $phaseNames = @("KEYFRAMES", "FACE SWAP", "VIDEO", "QC")
    $phaseColors = @($script:Colors.IndigoLight, $script:Colors.Cyan, $script:Colors.Amber, $script:Colors.Green)
    for ($index = 0; $index -lt $phaseNames.Count; $index++) {
        $x = 6.86 + ($index * 1.4)
        $null = Add-Rectangle $slide $x 4.36 1.12 0.55 $script:Colors.CanvasSoft $phaseColors[$index] 1 0 -Rounded
        $null = Add-Text $slide $phaseNames[$index] $x 4.36 1.12 0.55 8.5 $phaseColors[$index] "Aptos" -Bold -Align center -VerticalAlign middle
        if ($index -lt ($phaseNames.Count - 1)) {
            $null = Add-Line $slide ($x + 1.14) 4.635 ($x + 1.34) 4.635 $script:Colors.Border 1.1 -Arrow
        }
    }
    $null = Add-Text $slide "Why phase by model?" 6.86 5.26 2.0 0.25 12 $script:Colors.Text "Aptos Display" -Bold
    $null = Add-Text $slide "Wan2GP holds one large model at a time. Grouping work avoids repeated image -> edit -> video reloads across scenes." 6.86 5.62 5.43 0.47 10.5 $script:Colors.Muted
    Add-Pill $slide "NETWORK FAULT RETRIES" 6.86 6.16 1.92 0.3 $script:Colors.CyanSoft $script:Colors.Cyan $script:Colors.Cyan 8
    Add-Pill $slide "NO DOUBLE-SUBMIT ON GENERATE" 9.02 6.16 2.43 0.3 $script:Colors.AmberSoft $script:Colors.Amber $script:Colors.Amber 8
}

function Add-GovernanceSlide {
    param([string]$AssemblyImage)
    $slide = New-BlankSlide
    Add-SectionBase $slide "CONTROL + GOVERNANCE" 8
    Add-SlideTitle $slide "Operational confidence" "Consistency controls and human approval surround generation" "StoryForgeAI keeps creative context attached to the scene while preserving the operator's authority over what proceeds."

    $null = Add-Text $slide "CONSISTENCY" 0.55 2.2 1.8 0.23 9.5 $script:Colors.Cyan "Aptos" -Bold
    Add-OutcomeCard $slide "Cast identity" "Scene-scoped descriptions, references and optional face swap." 0.55 2.52 3.5 $script:Colors.Cyan
    Add-OutcomeCard $slide "Wardrobe timeline" "Changes carry forward across scenes instead of becoming a global lock." 0.55 3.6 3.5 $script:Colors.IndigoLight
    Add-OutcomeCard $slide "Frame continuity" "Reuse an end frame, withhold its reference, cut, or continue a compatible clip." 0.55 4.68 3.5 $script:Colors.Amber
    Add-OutcomeCard $slide "Model-aware prompting" "Family-specific instructions and exclusion routing survive backend differences." 0.55 5.76 3.5 $script:Colors.Green

    $null = Add-Text $slide "CONTROL POINTS" 4.39 2.2 1.8 0.23 9.5 $script:Colors.IndigoLight "Aptos" -Bold
    $checks = @(
        @{ T = "Choose"; B = "Select a variant, model pins and LoRA stack." },
        @{ T = "Inspect"; B = "Open agent artifacts, scene cards and exact prompts." },
        @{ T = "Intervene"; B = "Edit a card, import a keyframe or rerun one pass." },
        @{ T = "Approve"; B = "Only an approved attempt can enter final assembly." }
    )
    for ($index = 0; $index -lt $checks.Count; $index++) {
        $y = 2.53 + ($index * 0.95)
        $null = Add-Circle $slide 4.42 $y 0.43 $script:Colors.PanelLift $script:Colors.IndigoLight 1
        $null = Add-Text $slide ([string]($index + 1)) 4.42 $y 0.43 0.43 10 $script:Colors.IndigoLight "Aptos" -Bold -Align center -VerticalAlign middle
        $null = Add-Text $slide $checks[$index].T 5.0 ($y - 0.01) 1.0 0.24 12 $script:Colors.Text "Aptos Display" -Bold
        $null = Add-Text $slide $checks[$index].B 5.0 ($y + 0.3) 2.06 0.34 9.4 $script:Colors.Muted
    }
    $null = Add-Rectangle $slide 4.42 6.28 2.72 0.42 $script:Colors.GreenSoft $script:Colors.Green 0.8 0 -Rounded
    $null = Add-Text $slide "APPROVAL GATES ASSEMBLY" 4.42 6.28 2.72 0.42 9.5 $script:Colors.Green "Aptos" -Bold -Align center -VerticalAlign middle

    $null = Add-Text $slide "EVIDENCE IN THE WORKSPACE" 7.5 2.2 2.9 0.23 9.5 $script:Colors.Amber "Aptos" -Bold
    Add-ImageContained $slide $AssemblyImage 7.5 2.52 5.29 3.76
    $null = Add-Text $slide "Approved clips -> rough cut -> export package" 7.68 6.47 4.93 0.25 11 $script:Colors.Text "Aptos Display" -Bold -Align center
}

function Save-SingleSlideDeck {
    param(
        $SourceDeck,
        [int]$SlideIndex,
        [string]$Path
    )
    $single = $script:PowerPoint.Presentations.Add()
    try {
        $single.PageSetup.SlideWidth = ConvertTo-Points $script:SlideWidth
        $single.PageSetup.SlideHeight = ConvertTo-Points $script:SlideHeight
        $SourceDeck.Slides.Item($SlideIndex).Copy()
        $null = $single.Slides.Paste()
        $single.SaveAs($Path, 24)
    }
    finally {
        $single.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($single)
    }
}

function Assert-GeneratedDeck {
    param([string]$Path, [int]$ExpectedSlides)
    if (-not (Test-Path $Path)) {
        throw "Expected presentation was not created: $Path"
    }
    $opened = $script:PowerPoint.Presentations.Open($Path, 1, 0, 0)
    try {
        if ($opened.Slides.Count -ne $ExpectedSlides) {
            throw "Expected $ExpectedSlides slides in $Path, found $($opened.Slides.Count)."
        }
        foreach ($slide in $opened.Slides) {
            if ($slide.Shapes.Count -lt 5) {
                throw "Slide $($slide.SlideIndex) in $Path has too few shapes to be complete."
            }
        }
    }
    finally {
        $opened.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($opened)
    }
}

function Set-PresentationMetadata {
    param([string]$Path)

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::Open($Path, [System.IO.Compression.ZipArchiveMode]::Update)
    try {
        $entry = $archive.GetEntry("docProps/core.xml")
        if ($null -eq $entry) {
            throw "PowerPoint package has no core metadata: $Path"
        }

        $reader = New-Object System.IO.StreamReader($entry.Open())
        try {
            $core = $reader.ReadToEnd()
        }
        finally {
            $reader.Dispose()
        }

        $core = [regex]::Replace($core, "(<dc:creator>).*?(</dc:creator>)", '$1StoryForgeAI$2')
        $core = [regex]::Replace($core, "(<cp:lastModifiedBy>).*?(</cp:lastModifiedBy>)", '$1StoryForgeAI$2')
        $entry.Delete()
        $replacement = $archive.CreateEntry("docProps/core.xml")
        $writer = New-Object System.IO.StreamWriter(
            $replacement.Open(),
            (New-Object System.Text.UTF8Encoding($false))
        )
        try {
            $writer.Write($core)
        }
        finally {
            $writer.Dispose()
        }
    }
    finally {
        $archive.Dispose()
    }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$screenshots = Join-Path $repoRoot "public\screenshots"
$storyboardImage = Join-Path $screenshots "storyboard.png"
$canvasImage = Join-Path $screenshots "agentic-canvas.png"
$consoleImage = Join-Path $screenshots "generation-console.png"
$assemblyImage = Join-Path $screenshots "assembly.png"

foreach ($imagePath in @($storyboardImage, $canvasImage, $consoleImage, $assemblyImage)) {
    if (-not (Test-Path $imagePath)) {
        throw "Required screenshot not found: $imagePath"
    }
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$outputPath = (Resolve-Path $OutputDirectory).Path
$overviewPath = Join-Path $outputPath "StoryForgeAI-Overview.pptx"
$businessDeckPath = Join-Path $outputPath "StoryForgeAI-Business-Infographic.pptx"
$technicalDeckPath = Join-Path $outputPath "StoryForgeAI-Technical-Infographic.pptx"
$businessImagePath = Join-Path $outputPath "StoryForgeAI-Business-Infographic.png"
$technicalImagePath = Join-Path $outputPath "StoryForgeAI-Technical-Infographic.png"

try {
    $script:PowerPoint = New-Object -ComObject PowerPoint.Application
    $script:PowerPoint.Visible = -1
    $script:PowerPoint.DisplayAlerts = 1
    $script:Deck = $script:PowerPoint.Presentations.Add()
    $script:Deck.PageSetup.SlideWidth = ConvertTo-Points $script:SlideWidth
    $script:Deck.PageSetup.SlideHeight = ConvertTo-Points $script:SlideHeight

    Add-TitleSlide $storyboardImage
    Add-ProductFlowSlide
    Add-BusinessInfographicSlide
    Add-AgentCrewSlide $canvasImage
    Add-SceneContractSlide $storyboardImage
    Add-TechnicalInfographicSlide
    Add-McpSlide $consoleImage
    Add-GovernanceSlide $assemblyImage

    $script:Deck.SaveAs($overviewPath, 24)
    $script:Deck.Slides.Item(3).Export($businessImagePath, "PNG", 1920, 1080)
    $script:Deck.Slides.Item(6).Export($technicalImagePath, "PNG", 1920, 1080)
    Save-SingleSlideDeck $script:Deck 3 $businessDeckPath
    Save-SingleSlideDeck $script:Deck 6 $technicalDeckPath

    $script:Deck.Close()
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($script:Deck)
    $script:Deck = $null

    Set-PresentationMetadata $overviewPath
    Set-PresentationMetadata $businessDeckPath
    Set-PresentationMetadata $technicalDeckPath

    Assert-GeneratedDeck $overviewPath 8
    Assert-GeneratedDeck $businessDeckPath 1
    Assert-GeneratedDeck $technicalDeckPath 1

    foreach ($png in @($businessImagePath, $technicalImagePath)) {
        if (-not (Test-Path $png) -or (Get-Item $png).Length -lt 10000) {
            throw "Infographic export is missing or unexpectedly small: $png"
        }
    }

    Write-Host "Created and validated:"
    Write-Host "  $overviewPath"
    Write-Host "  $businessDeckPath"
    Write-Host "  $businessImagePath"
    Write-Host "  $technicalDeckPath"
    Write-Host "  $technicalImagePath"
}
finally {
    if ($null -ne $script:Deck) {
        try { $script:Deck.Close() } catch { }
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($script:Deck)
    }
    if ($null -ne $script:PowerPoint) {
        try { $script:PowerPoint.Quit() } catch { }
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($script:PowerPoint)
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}