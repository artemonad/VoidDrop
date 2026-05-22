<script lang="ts">
    /**
     * Logo — Premium neumorphic circle with a purple-to-blue gradient dot in the center.
     * Restored to the user's favorite tactile neumorphic aesthetic.
     */
    interface Props {
        size?: number | string;
        className?: string;
    }

    let { 
        size = 24, 
        className = "" 
    }: Props = $props();
</script>

<div class="logo-dot {className}" style="width: {size}px; height: {size}px;"></div>

<style>
    .logo-dot {
        border-radius: 50%;
        background-color: var(--bg-color);
        box-shadow: var(--shadow-out);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: all 0.4s ease;
        flex-shrink: 0;
        box-sizing: border-box;
    }

    .logo-dot::after {
        content: '';
        width: 33.33%;
        height: 33.33%;
        border-radius: 50%;
        background: linear-gradient(135deg, var(--purple), var(--blue));
        transition: all 0.4s ease;
    }

    /* Tactile pressed effect when hovered inside a logo link */
    :global(.logo:hover) .logo-dot {
        box-shadow: var(--shadow-in);
        transform: scale(0.95);
    }
</style>
